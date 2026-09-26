export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      let database = false;

      try {
        await env.DB.prepare("SELECT 1").run();
        database = true;
      } catch (error) {
        database = false;
      }

      return Response.json({
        ok: true,
        service: "Property Marketplace API",
        database
      });
    }

    return env.ASSETS.fetch(request);
  }
};
