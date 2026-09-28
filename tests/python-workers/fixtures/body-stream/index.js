// Reports the constructor that each kind of body stream exposes.
export default {
  async fetch(request) {
    const upstream = await fetch(new URL(request.url).searchParams.get('upstream'));
    return Response.json({
      request: request.body.constructor.name,
      response: upstream.body.constructor.name,
      constructed: new Response('x').body.constructor.name,
      isReadableStream: request.body instanceof ReadableStream,
    });
  },
};
