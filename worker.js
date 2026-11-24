// Serves the speech model from R2; everything else is a static asset.
// The model never changes under a given name, so browsers keep it for a year
// and download the 191 MB only once.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/sherpa/') && url.pathname.endsWith('.data')) {
      const obj = await env.MODELS.get(url.pathname.slice('/sherpa/'.length));
      if (!obj) return new Response('model not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(obj.size),
          'cache-control': 'public, max-age=31536000, immutable',
          etag: obj.httpEtag,
        },
      });
    }
    return env.ASSETS.fetch(req);
  },
};
