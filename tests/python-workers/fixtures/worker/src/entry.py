import asyncio
import hashlib
import json
import os
import sys
from urllib.parse import parse_qs, urlparse

from app.markup import first_paragraph
from workers import Response, WorkerEntrypoint, fetch

# Set on the first request, not at import: Cloudflare refuses entropy while a
# Worker's top level runs.
INTERPRETER = None
IMPORTS = globals().get("IMPORTS", 0) + 1


def interpreter_id():
    global INTERPRETER
    if INTERPRETER is None:
        INTERPRETER = os.urandom(8).hex()
    return INTERPRETER


class Default(WorkerEntrypoint):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.instance = None

    async def fetch(self, request):
        url = urlparse(request.url)
        query = {key: values[0] for key, values in parse_qs(url.query).items()}
        route = getattr(self, "route_" + url.path.strip("/").replace("-", "_") or "env", None)
        if route is None:
            return Response("not found", status=404)
        return await route(request, query)

    async def route_env(self, request, query):
        import workers.entrypoints

        with open(workers.entrypoints.__file__, "rb") as file:
            sdk_digest = hashlib.sha256(file.read()).hexdigest()
        from importlib.metadata import version

        return Response.json(
            {
                "path": sys.path,
                "cwd": os.getcwd(),
                "home": os.environ.get("HOME"),
                "python": list(sys.version_info[:3]),
                "platform": sys.platform,
                "sdk": version("workers-runtime-sdk"),
                "sdk_entrypoints_sha256": sdk_digest,
                "entry": __file__,
                "string_hash": hash("celld"),
                "set_order": list({"alpha", "beta", "gamma", "delta"}),
            }
        )

    async def route_json(self, request, query):
        return Response.json(
            {"ok": True, "items": [1, "two", None]},
            status=201,
            headers={"x-kind": "json"},
        )

    async def route_bytes(self, request, query):
        return Response(
            bytes(range(256)),
            headers={"content-type": "application/octet-stream"},
        )

    async def route_echo(self, request, query):
        return Response(
            request.body,
            headers={
                "x-method": request.method,
                "content-type": request.headers.get("content-type") or "",
            },
        )

    async def route_text(self, request, query):
        text = await request.text()
        return Response(text[::-1], headers={"x-length": str(len(text))})

    async def route_headers(self, request, query):
        return Response.json(
            {
                "list": request.headers.get("x-list"),
                "missing": request.headers.get("x-missing"),
            },
            headers={"x-reply": "a, b"},
        )

    async def route_kv(self, request, query):
        kv = self.env.KV
        await kv.put("alpha", "1")
        await kv.put("beta", json.dumps({"n": 2}))
        listed = await kv.list(prefix="")
        names = sorted(key["name"] for key in listed["keys"])
        beta = json.loads(await kv.get("beta"))
        await kv.delete("alpha")
        return Response.json(
            {"names": names, "beta": beta, "alpha_after_delete": await kv.get("alpha")}
        )

    async def route_fetch(self, request, query):
        upstream = await fetch(
            query["target"],
            method="POST",
            body="ping",
            headers={"x-from": "python"},
        )
        return Response.json(
            {
                "status": upstream.status,
                "body": await upstream.text(),
                "header": upstream.headers.get("x-upstream"),
            }
        )

    async def route_soup(self, request, query):
        return Response.json(first_paragraph("<p class='x'>hi <b>there</b></p><p>two</p>"))

    async def route_error(self, request, query):
        raise ValueError("boom from python")

    async def route_wait(self, request, query):
        async def write():
            await asyncio.sleep(0.05)
            await self.env.KV.put("waited-" + query["key"], "done")

        self.ctx.waitUntil(write())
        return Response("accepted", status=202)

    async def route_kv_get(self, request, query):
        return Response.json({"value": await self.env.KV.get(query["key"])})

    # celld-only routes below. They observe celld's hosting of the interpreter,
    # or behavior whose Cloudflare equivalent differs by design.

    async def route_identity(self, request, query):
        return Response.json({"interpreter": interpreter_id(), "imports": IMPORTS})

    async def route_exit(self, request, query):
        from js import process

        try:
            process.exit(1)
        except Exception as error:
            return Response.json({"refused": str(error)})
        return Response("process.exit returned", status=500)

    async def route_stack(self, request, query):
        import pyodide_js

        return Response.json({"stack": pyodide_js._module._emscripten_stack_get_current()})

    async def route_hold(self, request, query):
        async def held():
            outcome = "started"
            try:
                upstream = await fetch(query["hold"])
                outcome = "completed:" + await upstream.text()
            except Exception as error:
                outcome = "failed:" + type(error).__name__
            finally:
                await fetch(query["report"], method="POST", body=outcome)
            return outcome

        task = asyncio.ensure_future(held())
        self.ctx.waitUntil(task)
        return Response(await task)

    async def route_stream(self, request, query):
        from js import TransformStream, Uint8Array

        stream = TransformStream.new()
        writer = stream.writable.getWriter()
        chunks = int(query["chunks"])

        async def produce():
            written = 0
            outcome = "closed"
            try:
                chunk = Uint8Array.new(65536)
                for _ in range(chunks):
                    await writer.write(chunk)
                    written += 1
                await writer.close()
            except Exception as error:
                outcome = "error:" + type(error).__name__
            finally:
                writer.releaseLock()
                await fetch(
                    query["report"],
                    method="POST",
                    body=json.dumps({"written": written, "outcome": outcome}),
                )

        self.ctx.waitUntil(produce())
        return Response(stream.readable, headers={"content-type": "application/octet-stream"})

    async def route_recurse(self, request, query):
        sys.setrecursionlimit(1_000_000)

        def deeper(depth):
            return deeper(depth + 1) + 1

        try:
            deeper(0)
        except RecursionError as error:
            return Response.json({"recursion_error": str(error)})
