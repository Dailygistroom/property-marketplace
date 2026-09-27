function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(hash));
}

async function hashPassword(password, saltHex) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: fromHex(saltHex),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );

  return toHex(new Uint8Array(bits));
}

async function verifyPassword(password, saltHex, storedHash) {
  const calculated = await hashPassword(password, saltHex);
  return calculated === storedHash;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";

  for (const cookie of cookieHeader.split(";")) {
    const [key, ...value] = cookie.trim().split("=");

    if (key === name) {
      return decodeURIComponent(value.join("="));
    }
  }

  return null;
}

function sessionCookie(token) {
  return [
    `pm_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=604800"
  ].join("; ");
}

function clearSessionCookie() {
  return [
    "pm_session=",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0"
  ].join("; ");
}

async function getCurrentUser(request, env) {
  const token = getCookie(request, "pm_session");

  if (!token) return null;

  const tokenHash = await sha256(token);

  const result = await env.DB.prepare(`
    SELECT
      u.id,
      u.full_name,
      u.email,
      u.phone,
      u.role,
      u.status,
      u.created_at
    FROM auth_sessions s
    JOIN auth_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.expires_at > CURRENT_TIMESTAMP
      AND u.status = 'active'
    LIMIT 1
  `).bind(tokenHash).all();

  return result.results[0] || null;
}

async function requireUser(request, env) {
  const user = await getCurrentUser(request, env);

  if (!user) {
    return {
      ok: false,
      response: json(
        { ok: false, error: "Authentication required." },
        401
      )
    };
  }

  return { ok: true, user };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/api/health") {
      let database = false;

      try {
        await env.DB.prepare("SELECT 1").first();
        database = true;
      } catch (error) {
        database = false;
      }

      return json({
        ok: true,
        service: "Property Marketplace API",
        database
      });
    }

    // Register
    if (
      url.pathname === "/api/auth/register" &&
      request.method === "POST"
    ) {
      try {
        const data = await request.json();

        const fullName = String(data.full_name || "").trim();
        const email = String(data.email || "").trim().toLowerCase();
        const phone = String(data.phone || "").trim();
        const password = String(data.password || "");
        const role = String(data.role || "seeker").trim().toLowerCase();

        if (!fullName || !email || !password) {
          return json(
            {
              ok: false,
              error: "Full name, email and password are required."
            },
            400
          );
        }

        if (password.length < 8) {
          return json(
            {
              ok: false,
              error: "Password must be at least 8 characters."
            },
            400
          );
        }

        if (!["seeker", "agent", "landlord"].includes(role)) {
          return json(
            {
              ok: false,
              error: "Invalid account type."
            },
            400
          );
        }

        const existing = await env.DB.prepare(
          "SELECT id FROM auth_users WHERE email = ? LIMIT 1"
        ).bind(email).first();

        if (existing) {
          return json(
            {
              ok: false,
              error: "An account with this email already exists."
            },
            409
          );
        }

        const userId = crypto.randomUUID();
        const salt = toHex(randomBytes(16));
        const passwordHash = await hashPassword(password, salt);

        await env.DB.prepare(`
          INSERT INTO auth_users
          (id, full_name, email, phone, password_hash, role, status)
          VALUES (?, ?, ?, ?, ?, ?, 'active')
        `).bind(
          userId,
          fullName,
          email,
          phone || null,
          `${salt}:${passwordHash}`,
          role
        ).run();

        return json(
          {
            ok: true,
            message: "Account created successfully.",
            user: {
              id: userId,
              full_name: fullName,
              email,
              role
            }
          },
          201
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error: "Unable to create account."
          },
          500
        );
      }
    }

    // Login
    if (
      url.pathname === "/api/auth/login" &&
      request.method === "POST"
    ) {
      try {
        const data = await request.json();

        const email = String(data.email || "").trim().toLowerCase();
        const password = String(data.password || "");

        if (!email || !password) {
          return json(
            {
              ok: false,
              error: "Email and password are required."
            },
            400
          );
        }

        const user = await env.DB.prepare(`
          SELECT
            id,
            full_name,
            email,
            phone,
            password_hash,
            role,
            status
          FROM auth_users
          WHERE email = ?
          LIMIT 1
        `).bind(email).first();

        if (!user || user.status !== "active") {
          return json(
            {
              ok: false,
              error: "Invalid email or password."
            },
            401
          );
        }

        const parts = String(user.password_hash).split(":");

        if (parts.length !== 2) {
          return json(
            {
              ok: false,
              error: "Unable to authenticate account."
            },
            500
          );
        }

        const valid = await verifyPassword(
          password,
          parts[0],
          parts[1]
        );

        if (!valid) {
          return json(
            {
              ok: false,
              error: "Invalid email or password."
            },
            401
          );
        }

        const token = toHex(randomBytes(32));
        const tokenHash = await sha256(token);

        await env.DB.prepare(`
          DELETE FROM auth_sessions
          WHERE user_id = ?
        `).bind(user.id).run();

        await env.DB.prepare(`
          INSERT INTO auth_sessions
          (id, user_id, token_hash, expires_at)
          VALUES (
            ?,
            ?,
            ?,
            datetime('now', '+7 days')
          )
        `).bind(
          crypto.randomUUID(),
          user.id,
          tokenHash
        ).run();

        return json(
          {
            ok: true,
            message: "Login successful.",
            user: {
              id: user.id,
              full_name: user.full_name,
              email: user.email,
              phone: user.phone,
              role: user.role
            }
          },
          200,
          {
            "Set-Cookie": sessionCookie(token)
          }
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error: "Unable to log in."
          },
          500
        );
      }
    }

    // Current logged-in user
    if (
      url.pathname === "/api/auth/me" &&
      request.method === "GET"
    ) {
      try {
        const user = await getCurrentUser(request, env);

        return json({
          ok: true,
          authenticated: !!user,
          user: user || null
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: "Unable to check session."
          },
          500
        );
      }
    }

    // Logout
    if (
      url.pathname === "/api/auth/logout" &&
      request.method === "POST"
    ) {
      try {
        const token = getCookie(request, "pm_session");

        if (token) {
          const tokenHash = await sha256(token);

          await env.DB.prepare(
            "DELETE FROM auth_sessions WHERE token_hash = ?"
          ).bind(tokenHash).run();
        }

        return json(
          {
            ok: true,
            message: "Logged out successfully."
          },
          200,
          {
            "Set-Cookie": clearSessionCookie()
          }
        );
      } catch (error) {
        return json(
          {
            ok: false,
            error: "Unable to log out."
          },
          500,
          {
            "Set-Cookie": clearSessionCookie()
          }
        );
      }
    }

    // Create property listing
    if (
      url.pathname === "/api/properties" &&
      request.method === "POST"
    ) {
      try {
        const auth = await requireUser(request, env);

        if (!auth.ok) {
          return auth.response;
        }

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
            String(data[field]).trim() === ""
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

        const propertyId = crypto.randomUUID();

        await env.DB.prepare(`
          INSERT INTO properties
          (
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).bind(
          propertyId,
          auth.user.id,
          data.title,
          data.description || "",
          data.category,
          data.property_type,
          Number(data.price),
          data.location,
          data.bedrooms ? Number(data.bedrooms) : null,
          data.bathrooms ? Number(data.bathrooms) : null,
          data.area_sqm ? Number(data.area_sqm) : null,
          data.amenities || ""
        ).run();

        for (let i = 0; i < images.length; i++) {
          await env.DB.prepare(`
            INSERT INTO property_images
            (id, property_id, image_url, sort_order)
            VALUES (?, ?, ?, ?)
          `).bind(
            crypto.randomUUID(),
            propertyId,
            images[i],
            i
          ).run();
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
            error: "Unable to create property listing."
          },
          500
        );
      }
    }

    // Get approved properties
    if (
      url.pathname === "/api/properties" &&
      request.method === "GET"
    ) {
      try {
        const result = await env.DB.prepare(`
          SELECT *
          FROM properties
          WHERE status = 'approved'
          ORDER BY created_at DESC
        `).all();

        return json({
          ok: true,
          properties: result.results
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: "Unable to load properties."
          },
          500
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
