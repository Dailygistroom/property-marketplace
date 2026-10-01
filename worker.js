export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/api/health") {
      try {
        await env.DB.prepare("SELECT 1").first();

        return json({
          ok: true,
          service: "Property Marketplace API",
          database: true,
          images: !!env.IMAGES
        });
      } catch (error) {
        return json(
          {
            ok: false,
            service: "Property Marketplace API",
            database: false,
            error: error.message
          },
          500
        );
      }
    }

    // Serve private R2 images through the Worker
    if (url.pathname.startsWith("/api/images/")) {
      const key = decodeURIComponent(
        url.pathname.replace("/api/images/", "")
      );

      if (!key) {
        return json({ ok: false, error: "Image not found." }, 404);
      }

      try {
        const object = await env.IMAGES.get(key);

        if (!object) {
          return json({ ok: false, error: "Image not found." }, 404);
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=31536000");

        return new Response(object.body, {
          headers
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: "Unable to load image."
          },
          500
        );
      }
    }

    // Get approved properties
    if (request.method === "GET" && url.pathname === "/api/properties") {
      try {
        const result = await env.DB.prepare(`
          SELECT *
          FROM properties
          WHERE status = 'approved'
          ORDER BY created_at DESC
        `).all();

        const properties = result.results || [];

        for (const property of properties) {
          const imageResult = await env.DB.prepare(`
            SELECT image_url
            FROM property_images
            WHERE property_id = ?
            ORDER BY sort_order ASC
          `)
            .bind(property.id)
            .all();

          property.images = (imageResult.results || []).map(
            (row) => `/api/images/${encodeURIComponent(row.image_url)}`
          );
        }

        return json({
          ok: true,
          properties
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: error.message
          },
          500
        );
      }
    }

    // Submit a property
    if (request.method === "POST" && url.pathname === "/api/properties") {
      try {
        const data = await request.json();

        const required = [
          "title",
          "category",
          "property_type",
          "price",
          "location"
        ];

        for (const field of required) {
          if (
            data[field] === undefined ||
            data[field] === null ||
            data[field] === ""
          ) {
            return json(
              {
                ok: false,
                error: `${field} is required.`
              },
              400
            );
          }
        }

        const images = Array.isArray(data.images)
          ? data.images
          : [];

        if (images.length > 6) {
          return json(
            {
              ok: false,
              error: "A property can have a maximum of 6 pictures."
            },
            400
          );
        }

        if (!env.IMAGES) {
          return json(
            {
              ok: false,
              error: "Image storage is not configured."
            },
            500
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
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .bind(
            propertyId,
            data.user_id || null,
            data.title,
            data.description || "",
            data.category,
            data.property_type,
            Number(data.price) || 0,
            data.location,
            Number(data.bedrooms) || null,
            Number(data.bathrooms) || null,
            Number(data.area_sqm) || null,
            data.amenities || "",
            "pending"
          )
          .run();

        for (let i = 0; i < images.length; i++) {
          const image = images[i];

          if (typeof image !== "string") {
            continue;
          }

          if (!image.startsWith("data:")) {
            continue;
          }

          const match = image.match(
            /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
          );

          if (!match) {
            continue;
          }

          const contentType = match[1];
          const base64 = match[2];

          const extension = getExtension(contentType);

          const key =
            `properties/${propertyId}/` +
            `${crypto.randomUUID()}.${extension}`;

          const bytes = base64ToUint8Array(base64);

          await env.IMAGES.put(key, bytes, {
            httpMetadata: {
              contentType
            }
          });

          await env.DB.prepare(`
            INSERT INTO property_images (
              id,
              property_id,
              image_url,
              sort_order
            )
            VALUES (?, ?, ?, ?)
          `)
            .bind(
              crypto.randomUUID(),
              propertyId,
              key,
              i
            )
            .run();
        }

        return json(
          {
            ok: true,
            message: "Property submitted successfully.",
            property_id: propertyId,
            status: "pending"
          },
          201
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error: error.message
          },
          500
        );
      }
    }

    // Let Cloudflare serve the website
    return env.ASSETS.fetch(request);
  }
};


// Convert a data URL base64 string into bytes
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}


// Get a safe file extension
function getExtension(contentType) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif"
  };

  return map[contentType] || "jpg";
}


// JSON response helper
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
