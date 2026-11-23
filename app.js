import express from "express";
import cors from "cors";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import productRoutes from "./routes/routes.js";
import fs from "fs";
import { startScheduler } from "./jobs/scheduler.js";
import cookieSession from "cookie-session";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

const app = express();
const PORT = process.env.PORT || 31876;
app.locals.appVersion = packageInfo.version;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ---------------------------
// cookie-session
// ---------------------------
// samo v produkciji prisili HTTPS
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    const isHttps =
      req.secure || (typeof proto === 'string' && proto.split(',')[0].trim() === 'https');

    if (isHttps) return next();

    // 308 ohrani metodo (POST ostane POST); če želiš lahko pustiš 301
    return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
  });
}

app.use(
  cookieSession({
    name: "sid",
    keys: [process.env.SESSION_SECRET || "dev_secret_change_me"],
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // true only on HTTPS
  })
);

// make session user available in all EJS templates
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  next();
});

// ---------------------------
// Favicon
// ---------------------------
app.get("/favicon.ico", (_req, res) => {
  const p = path.join(__dirname, "public", "favicon.ico");
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(204).end();
});

// ---------------------------
// Endpoints
// ---------------------------
app.get("/api/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
    });
    res.type("text/html").send(response.data);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error scraping page");
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, pid: process.pid }));
app.use("/api", productRoutes);

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Pages
app.get("/", (req, res) => res.render("pages/home", { active: "home" }));
app.get("/basket", (req, res) => res.render("pages/basket", { active: "basket" }));
app.get("/about", (req, res) => res.render("pages/about", { active: "about" }));
app.get("/login", (req, res) => res.render("pages/login", { active: "login" }));
app.get("/register", (req, res) => res.render("pages/register", { active: "register" }));
app.get("/profile", (req, res) => res.render("pages/profile", { active: "profile" }));
app.get("/overview", (req, res) => res.render("pages/overview", { active: "overview" }));

// Static assets (CSS/JS/images), but do NOT serve index.html automatically
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Redirect home to /basket
//app.get("/", (req, res) => {
//  res.redirect(302, "/basket");
//});


// ---------------------------
// Start to listen
// ---------------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  startScheduler();
});
