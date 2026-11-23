import express from "express";
import { db } from "../db.js";
import bcrypt from "bcrypt";
import { extractDataFromDM, extractDataFromMercator, extractDataFromSpar, extractDataFromMimovrste } from "../routes/scrapper.js";


const router = express.Router();
const dec = s => atob(s);

// -----------------------------
// Auth middleware
// -----------------------------
const requireAuth = (req, res, next) => {
  if (!req.session?.user) return res.status(401).json({ error: "Not authenticated" });
  next();
};

// Za pripenjanje polja v json
const getHistory = async function (productId) {
  if (!productId)
    return [];

  // če uporabim oklepaje [history] bom dobil samo podatke brez SQL headerjev
  const [history] = await db.query(
    `SELECT product_id, date, price, price_per_unit
       FROM product_history
       WHERE product_id = (?)
       ORDER BY date DESC
       LIMIT 5`,
    [productId]
  );

  // Pretvorba objekta
  const historyMap = history.map(r => ({
    ...r,
    price: parseFloat(r.price),
    price_per_unit: parseFloat(r.price_per_unit),
    date: new Date(r.date),
  }));

  return historyMap;
}

// Za pripenjanje polja v json
const getSecondary = async function (productId, userId) {
  if (!productId)
    return [];

  const [secondary] = await db.query(
    `SELECT 
        sp.id as id,
        sp.parent_product_id, 
        sp.product_id,
        p.url,
        p.name,
        p.price,
        p.price_per_unit,
        CASE WHEN sp.parent_product_id = sp.product_id THEN 1 ELSE 0 END as sort
      FROM product_secondary sp
      INNER JOIN product p ON p.id = sp.product_id
      WHERE sp.parent_product_id = ?
        AND sp.user_id = ?
      ORDER BY sort DESC, sp.product_id`,
    [productId, userId]);

  const secondaryMap = await Promise.all(
    secondary.map(async (s) => ({
      ...s,
      price: parseFloat(s.price),
      price_per_unit: parseFloat(s.price_per_unit),
      history: await getHistory(s.product_id),
    }))
  );

  return secondaryMap;
}

// Združevanje podatkov v en json
const getProduct = async function (productId, userId) {
  if (!productId)
    return {};

  // fancy sintaksa da namesto vrstic dobim eno vrstico
  const [[product] = []] = await db.query(`SELECT * FROM product WHERE id = ?`, [productId]);
  const secondary = await getSecondary(product?.id, userId);

  return {
    ...product,
    secondary
  };
}

// INSERT or UPDATE + add history
router.post("/product", requireAuth, async (req, res) => {
  const { url, code, name, price, parentProductId, unit, price_per_unit, image_src, price_per_unit_alternate, unit_alternate } = req.body;
  if (!url || !name || !price) {
    return res.status(400).json({ error: 'Vsi podatki niso izpolnjeni!' });
  }

  if (isNaN(price)) {
    return res.status(400).json({ error: 'Cena ni v numeričnem formatu!' });
  }

  const userId = req?.session?.user?.id;

  let store;
  if (url.includes("mercatoronline.si"))
    store = 'Mercator';
  else if (url.includes("online.spar.si"))
    store = 'Spar';
  else if (url.includes("hofer.si"))
    store = 'Hofer';
  else if (url.includes("dm.si"))
    store = 'DM';
  else if (url.includes("mimovrste.com"))
    store = 'Mimovrste';

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO product (url, code, name, price, unit, price_per_unit, image_src, store, price_per_unit_alternate, unit_alternate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
          name = VALUES(name),  
          code = VALUES(code),
          unit = VALUES(unit),
          price_per_unit = VALUES(price_per_unit),
          image_src = VALUES(image_src),
          price = VALUES(price),
          store = VALUES(store),
          price_per_unit_alternate = VALUES(price_per_unit_alternate),
          unit_alternate = VALUES(unit_alternate),
          ts_upd = CURRENT_TIMESTAMP()`,
      [url, code, name, price, unit, price_per_unit, image_src, store, price_per_unit_alternate, unit_alternate]
    );

    // Pridobi zadnji vnešeni id
    const [[{ id }]] = await conn.query(
      "SELECT id FROM product WHERE url = ?",
      [url]
    );

    // Vnesi v zgodovino zadnjo poizvedovanje cene
    await conn.query(
      `INSERT INTO product_history (product_id, date, price, price_per_unit)
       VALUES (?, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE
      price = VALUES(price),
      price_per_unit = VALUES(price_per_unit)`,
      [id, price, price_per_unit]
    );

    // Vnesi povezavo samo nase
    if (parentProductId == null) {
      await conn.query(
        `INSERT INTO product_secondary (parent_product_id, product_id, user_id)
       VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
      user_id = VALUES(user_id)`,
        [id, id, userId]
      );
    }
    else {
      await conn.query(
        `INSERT INTO product_secondary (parent_product_id, product_id, user_id)
       VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
      user_id = VALUES(user_id)`,
        [parentProductId, id, userId]
      );
    }

    await conn.commit();
    res.json({ success: true, id });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// GET izpiše vse produkte + zgodovina + ekvivalenti
router.get("/products", requireAuth, async (req, res) => {
  try {
    const userId = req?.session?.user?.id;

    // dobimo glavne izdelke. Glavni izdelki imajo referenco sami nase
    const [products] = await db.query(
      `SELECT ps.id, parent_product_id, product_id 
      FROM product_secondary ps
      WHERE ps.parent_product_id = ps.product_id
        AND ps.user_id = ?`,
      [userId]
    );

    // pretvorba objekta
    const productsMap = [];

    for (const p of products) {
      const product = await getProduct(p.parent_product_id, userId);

      if (product) {
        product.product_secondary_id = p.id;
      }

      productsMap.push(product);
    }


    res.json(productsMap);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Izbriši glavni izdelek
router.delete("/product/:id", requireAuth, async (req, res) => {
  try {
    await db.query(
      "DELETE FROM product_secondary WHERE parent_product_id = ?",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Izbriši sekundarni izdelek
router.delete("/secondary/:id", requireAuth, async (req, res) => {
  try {
    await db.query(
      "DELETE FROM product_secondary WHERE id = ?",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Registriraj uporabnika
router.post("/register", async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { userName, firstName, lastName, password } = req.body;
    if (!userName || !firstName || !lastName || !password) {
      return res.status(400).json({ error: "Vsi podatki niso izpolnjeni" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Ta način vrne insertirani ID
    const [result] = await conn.query(
      `INSERT INTO user (user_name, first_name, last_name, password)
       VALUES (?, ?, ?, ?)`,
      [userName, firstName, lastName, hashedPassword]
    );

    const userId = result.insertId;

    // ustvari sejo
    req.session.user = {
      id: userId,
      userName,
      firstName,
      lastName,
    };

    return res.status(200).json({ success: true, user: req.session.user });
  } catch (err) {

    // Olepšaj napake iz baze
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Uporabniško ime že obstaja" });
    }

    console.error(err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// pridobi uporabnika iz seje
router.get("/me", (req, res) => {
  if (!req.session?.user) return res.json({ loggedIn: false });
  return res.json({ loggedIn: true, user: req.session.user });
});

// odjavi uporabnika iz seje in izbriši cookie
router.post("/logout", (req, res) => {
  req.session = null;
  //return res.redirect("/home");
  return res.redirect("/");
});

// Prijava uporabnika in kreiranje seje
router.post("/login", async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { userName, password } = req.body;

    if (!userName || !password) {
      return res.status(400).json({ error: "Vsi podatki niso izpolnjeni" });
    }

    // hitra sintaksa da shraniš vrstice v točno en objekt
    const [[user] = []] = await conn.query(
      `SELECT id, user_name, first_name, last_name, password
       FROM user
       WHERE user_name = ?`,
      [userName]
    );

    if (!user) {
      return res.status(401).json({ error: "Napačno uporabniško ime ali geslo" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: "Napačno uporabniško ime ali geslo" });
    }

    const fullName = `${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim() || user.user_name;
    // create session
    req.session.user = {
      id: user.id,
      userName: user.user_name,
      firstName: user.first_name,
      lastName: user.last_name,
      fullName: fullName
    };

    await conn.query(
      `UPDATE user SET last_login = NOW() WHERE user_name = ?`,
      [userName]
    );
    return res.json({ success: true, user: req.session.user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Pridobi detajle uporabnika
router.get("/profile", requireAuth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const userId = req.session.user.id;

    const [[u] = []] = await conn.query(
      `SELECT user_name, first_name, last_name, email, is_active_mail
       FROM user
       WHERE id = ?`,
      [userId]
    );

    if (!u) return res.status(404).json({ error: "Uporabnik ne obstaja" });

    return res.json({
      userName: u.user_name,
      firstName: u.first_name,
      lastName: u.last_name,
      email: u.email ?? "",
      activeEmail: !!u.is_active_mail,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Posodobi polja uporabnika
router.put("/profile", requireAuth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const userId = req.session.user.id;
    const { firstName, lastName, email, password, activeEmail } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({ error: "Ime in priimek sta obvezna" });
    }

    // zgradi update dinamično (geslo je opcijsko)
    const fields = [];
    const params = [];

    fields.push("first_name = ?");
    params.push(firstName);

    fields.push("last_name = ?");
    params.push(lastName);

    fields.push("email = ?");
    params.push(email || null);

    fields.push("is_active_mail = ?");
    params.push(activeEmail ? 1 : 0);

    if (password && password.length > 0) {
      const hashed = await bcrypt.hash(password, 10);
      fields.push("password = ?");
      params.push(hashed);
    }

    params.push(userId);

    await conn.query(
      `UPDATE user SET ${fields.join(", ")} WHERE id = ?`,
      params
    );

    // posodobi sejo (da se header/ime takoj osveži)
    const fullName = `${firstName} ${lastName}`.trim() || req.session.user.userName;
    req.session.user.firstName = firstName;
    req.session.user.lastName = lastName;
    req.session.user.fullName = fullName;

    return res.json({ success: true, user: req.session.user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Hop Cefizelj, pa sem te dobil
router.get("/extract", async (req, res) => {
  try {
    const { url, code } = req.query;

    if (!url && !code) {
      return res.status(400).json({ error: "Missing url or code" });
    }

    let product = {};
    let u;
    let hostname;
    try {
      u = new URL(url);
      hostname = u.hostname.toLowerCase();
    }
    catch (err) {
      return res.status(400).json({ error: "Invalid URL ${url}" });
    }

    if (hostname.includes("mercatoronline.si"))
      product = await extractDataFromMercator(u, code);
    else if (hostname.includes("online.spar.si"))
      product = await extractDataFromSpar(u);
    else if (hostname.includes("dm.si"))
      product = await extractDataFromDM(u);
    else if (hostname.includes("mimovrste.com"))
      product = await extractDataFromMimovrste(u);
    else
      return res.status(400).json({ error: "Nepodprta trgovina!" });

    if (!product) {
      return res.status(422).json({
        error: hostname.includes("mimovrste.com")
          ? "Podatkov izdelka iz Mimovrste ni bilo mogoče prebrati. Stran ni vrnila prepoznavnega izdelka."
          : "Podatkov izdelka s te strani ni bilo mogoče prebrati."
      });
    }

    return res.status(200).json(product);

  } catch (err) {
    console.error(err);
    const status = err.code === "CLOUDFLARE_CHALLENGE" ? 502 : 500;
    return res.status(status).json({ error: err.message });
  }
});

// Odjava uporabnika iz pošiljanja mailov
router.get("/unsubscribe", async (req, res) => {
  const conn = await db.getConnection();
  try {
    //todo naredi hash na podlagi userimena in ga hashaj in odhashaj
    const hashedUserName = String(req.query.hun || "");
    if (!hashedUserName)
      return res.status(400).send("Napaka pri odjavi");

    const userName = dec(hashedUserName);

    const [[userId]] = await conn.query(
      "SELECT id FROM user WHERE user_name = ?",
      [userName]
    );

    if (!userId)
      return res.status(400).send("Napaka pri odjavi");

    await conn.query(
      "UPDATE user SET is_active_mail = 0 WHERE id = ?",
      [userId.id]
    );

    return res.status(200).send("Uspešno si odjavljen/a od e-poštnih obvestil. ✅");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Napaka pri odjavi.");
  } finally {
    conn.release();
  }
});


router.get("/overview", requireAuth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    const userId = req.session.user.id;

    const [overview] = await conn.query(
      `SELECT	
        t.parent_product_id,
        p.name as parent_product_name,
        t.name,
        t.price_per_unit,
        p.price,
        t.store,
        t.url,
        p.unit,
        p.image_src
      FROM (
        SELECT 
          ps.parent_product_id,
              p.name,
              p.price_per_unit,
              p.price,
              p.store,
              p.url,
          rank() OVER (PARTITION BY ps.parent_product_id ORDER BY p.price_per_unit ASC) AS rnk
        FROM product_secondary ps
        INNER JOIN product p ON p.id = ps.product_id
        WHERE ps.user_id = ?
        ORDER BY ps.parent_product_id
      ) t
      INNER JOIN product p ON t.parent_product_id = p.id
      WHERE t.rnk = 1`,
      [userId]
    );

    return res.json(overview);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});


export default router;
