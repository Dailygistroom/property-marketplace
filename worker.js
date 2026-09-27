export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
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

    // Create property listing
    if (url.pathname === "/api/properties" && request.method === "POST") {
      try {
        const data = await request.json();

        if (!data.title || !data.category || !data.property_type || !data.price || !data.location) {
          return Response.json(
            { ok: false, error: "Title, category, property type, price and location are required." },
            { status: 400 }
          );
        }

        const images = Array.isArray(data.images) ? data.images : [];

        if (images.length > 6) {
          return Response.json(
            { ok: false, error: "A property can have a maximum of 6 pictures." },
            { status: 400 }
          );
        }

        const propertyId = crypto.randomUUID();

        await env.DB.prepare(`
          INSERT INTO properties (
            id,
            user_id,
            title,
            description,
            category,
            property_type,
            price,
            location,
            bedrooms,
            bathrooms,
            area_sqm,
            amenities,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).bind(
          propertyId,
          data.user_id || null,
          data.title,
          data.description || null,
          data.category,
          data.property_type,
          Number(data.price),
          data.location,
          data.bedrooms || null,
          data.bathrooms || null,
          data.area_sqm || null,
          data.amenities ? JSON.stringify(data.amenities) : null
        ).run();

        for (let i = 0; i < images.length; i++) {
          await env.DB.prepare(`
            INSERT INTO property_images (
              id,
              property_id,
              image_url,
              sort_order
            ) VALUES (?, ?, ?, ?)
          `).bind(
            crypto.randomUUID(),
            propertyId,
            images[i],
            i
          ).run();
        }

        return Response.json({
          ok: true,
          message: "Property submitted successfully.",
          property_id: propertyId,
          status: "pending"
        }, { status: 201 });

      } catch (error) {
        return Response.json(
          { ok: false, error: "Unable to create property listing." },
          { status: 500 }
        );
      }
    }

    // Get approved properties
    if (url.pathname === "/api/properties" && request.method === "GET") {
      try {
        const result = await env.DB.prepare(`
          SELECT *
          FROM properties
          WHERE status = 'approved'
          ORDER BY created_at DESC
        `).all();

        return Response.json({
          ok: true,
          properties: result.results
        });
      } catch (error) {
        return Response.json(
          { ok: false, error: "Unable to load properties." },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
