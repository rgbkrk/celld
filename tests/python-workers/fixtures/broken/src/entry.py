from workers import Response, WorkerEntrypoint

raise RuntimeError("broken at import")


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response("unreachable")
