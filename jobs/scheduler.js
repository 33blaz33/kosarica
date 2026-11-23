import cron from 'node-cron';
import { db } from "../db.js";
import { extractDataFromMercator, extractDataFromSpar, extractDataFromDM, extractDataFromMimovrste } from "../routes/scrapper.js";
import nodemailer from "nodemailer";
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// --- KONFIGURACIJA POTI (Pomembno za cPanel Cron) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prisilimo nalaganje .env datoteke iz mape, kjer se nahaja scheduler.js
// Če je .env v mapi višje, uporabi path.join(__dirname, '..', '.env')
dotenv.config({ path: path.join(__dirname, '.env') });

const enc = s => btoa(s);

export const refreshPrices = async function () {
    console.log("Začenjam osveževanje cen...");
    const conn = await db.getConnection();

    try {
        const [products] = await conn.query(
            "SELECT id, url, code FROM product"
        );

        for (const p of products) {
            try {
                let product;

                if (p.url.includes("mercatoronline.si"))
                    product = await extractDataFromMercator(p.url, p.code);
                else if (p.url.includes("online.spar.si"))
                    product = await extractDataFromSpar(p.url);
                else if (p.url.includes("dm.si"))
                    product = await extractDataFromDM(p.url, p.code);
                else if (p.url.includes("mimovrste.com"))
                    product = await extractDataFromMimovrste(p.url, p.code);

                if (!product)
                    throw new Error("Ni najdenih podatkov");

                await conn.query(
                    `UPDATE product SET price = ?, price_per_unit = ?, price_per_unit_alternate = ?, unit_alternate = ?, ts_upd = NOW() WHERE id = ? `,
                [product.price, product.price_per_unit, product.price_per_unit_alternate, product.unit_alternate, p.id]);

                await conn.query(
                    `INSERT INTO product_history
                     (product_id, date, price, price_per_unit)
                     VALUES (?, NOW(), ?, ?)
                     ON DUPLICATE KEY UPDATE
                     price = VALUES(price),
                     price_per_unit = VALUES(price_per_unit)`,
                    [p.id, product.price, product.price_per_unit]
                );

            } catch (e) {
                console.error(`Refresh failed for product ${p.id}:`, e.message);
            }
        }
    } finally {
        conn.release();
    }
};

export const sendMail = async function () {
    console.log("Začenjam pošiljanje e-pošte...");
    const conn = await db.getConnection();
    
    try {
        const [users] = await conn.query(
            "SELECT id, first_name, last_name, email, last_email_message_id, user_name FROM user WHERE is_active_mail = 1 AND email <> ''"
        );

        const [changes] = await conn.query(
            `SELECT
                t.product_id,
                ps.user_id,
                t.date,
                t.price,
                t.price_prev,
                t.price - t.price_prev as price_diff,
                p.name,
                p.url,
                p.store
            FROM (
                SELECT 
                    h.product_id, 
                    h.date, 
                    h.price, 
                    LAG(h.price) OVER (PARTITION BY h.product_id ORDER BY date) as price_prev
                FROM product_history h
                WHERE date > DATE_ADD(CURDATE(), INTERVAL -7 DAY)
            ) t
            INNER JOIN product p ON p.id = t.product_id
            INNER JOIN product_secondary ps ON ps.product_id = p.id
            WHERE t.date = CURDATE()
                AND t.price_prev  <> t.price
            ORDER BY p.store, t.price - t.price_prev ASC`
        );

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT),
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });

        for (const u of users) {
            try {
                const dateSl = new Date().toLocaleDateString("sl-SI");
                const escapeHtml = (s = "") => String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#039;"}[m]));

                const changesForUser = changes.filter(c => c.user_id === u.id);
                if (changesForUser.length === 0) continue;

                const rows = changesForUser.map(e => {
                    const price = Number(e.price).toFixed(2);
                    const prev = Number(e.price_prev).toFixed(2);
                    const diff = (Number(e.price) - Number(e.price_prev)).toFixed(2);
                    const diffText = Number(diff) > 0 ? `+${diff}` : diff;
                    const diffPerc = (diff / prev * 100).toFixed(0);

                    return `
                        <tr>
                            <td>${e.store}</td>
                            <td><a href="${e.url}">${escapeHtml(e.name)}</a></td>
                            <td align="right">${prev}</td>
                            <td align="right">${price}</td>
                            <td align="right" style="color:${diff > 0 ? "red" : "green"}">${diffText}€ (${diffPerc}%)</td>
                        </tr>`;
                }).join("");

                const hashedUserName = enc(u.user_name);
                const unsubscribeUrl = `https://${process.env.DOMAIN}/api/unsubscribe?hun=${hashedUserName}`;

                const html = `
                    <html>
                    <body style="font-family: Arial, sans-serif; font-size:14px; color:#111;">
                        <p>Nove cene na dan ${dateSl} so:</p>
                        <table width="100%" cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;">
                            <tr>
                                <th align="left">Trgovina</th>
                                <th align="left">Izdelek</th>
                                <th align="right">Prej</th>
                                <th align="right">Trenutno</th>
                                <th align="right">Razlika</th>
                            </tr>
                            ${rows}
                        </table>
                        <p style="font-size:12px; color:#666;">To sporočilo je bilo poslano samodejno. <a href="${unsubscribeUrl}">Odjava.</a></p>
                    </body>
                    </html>`;

                const info = await transporter.sendMail({
                    from: `"Kosarica Info" <${process.env.SMTP_USER}>`,
                    to: u.email,
                    subject: "Posodobljene cene",
                    html: html,
                    headers: {
                        "List-Unsubscribe": `<${unsubscribeUrl}>`,
                        "In-Reply-To": u.last_email_message_id,
                        "References": u.last_email_message_id
                    },
                });

                await conn.query(
                    `UPDATE user SET last_email_message_id = ? WHERE id = ?`,
                    [info.messageId, u.id]
                );

            } catch (err) {
                console.error(`Napaka pri pošiljanju uporabniku ${u.email}:`, err);
            }
        }
    } finally {
        conn.release();
    }
};

export function startScheduler() {
    
    /*
    // Ob 4:00 zjutraj
    cron.schedule('0 4 * * *', async () => {
        await refreshPrices();
    });

    // Ob 11:00 dopoldne
    cron.schedule('0 11 * * *', async () => {
        await sendMail();
    });*/
}

// --- IZVRŠILNI BLOK ZA CPANEL CRON ---
if (process.argv[1] === __filename) {
    const task = process.argv[2]; 
    
    (async () => {
        try {
            if (task === 'refresh') {
                await refreshPrices();
                console.log("Uspeh: Cene osvežene.");
            } else if (task === 'mail') {
                await sendMail();
                console.log("Uspeh: Maili poslani.");
            } else {
                console.log("Uporaba: node scheduler.js [refresh|mail]");
            }
        } catch (err) {
            console.error("KRITIČNA NAPAKA:", err);
        } finally {
            // Zapremo pool povezav, da se proces v cPanelu dejansko konča
            if (db && db.end) {
                await db.end();
            }
            process.exit(0);
        }
    })();
}
