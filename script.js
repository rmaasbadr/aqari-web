// Run: node script.js
// Open: http://localhost:3000

if (typeof window === "undefined") {

// SERVER: accounts and sessions
// Run with: node script.js
// Accounts stay on the server. Passwords are hashed, never saved as plain text.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { pool, readUsers, saveUser, listProperties, saveProperty } = require("./db.js");

// كائنات عادية لحفظ الجلسات وعدد المحاولات أثناء تشغيل الخادم.
const sessions = {};
const attempts = {};
const publicFiles = ["index.html", "style.css", "script.js", "aqari-logo.png", "config.js"];
const officialFalUrl = "https://rega.gov.sa/rega-services/real-estate-inquiries/استعلام-عن-رخص-فال/";


// البحث بحلقة for بدل تكرار عمليات البحث المختصرة داخل الطلبات.
function findUserByEmail(users, email) {
    for (let i = 0; i < users.length; i++) {
        if (users[i].email === email) return users[i];
    }
    return null;
}

function findUserById(users, id) {
    for (let i = 0; i < users.length; i++) {
        if (users[i].id === id) return users[i];
    }
    return null;
}

function findUserByToken(users, token, type) {
    const hash = tokenHash(token);
    for (let i = 0; i < users.length; i++) {
        if (type === "reset" && users[i].resetHash === hash && users[i].resetExpires > Date.now()) return users[i];
        if (type === "verify" && users[i].verifyHash === hash && users[i].verifyExpires > Date.now()) return users[i];
    }
    return null;
}

async function passwordHash(password) {
    return bcrypt.hash(password, 12);
}

async function passwordMatches(password, user) {
    return bcrypt.compare(password, user.passwordHash.replace(/^\$2y\$/, "$2b$"));
}

function tokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function publicUser(user) {
    // Return profile fields only. Do not send password hashes or email tokens.
    const fields = ["id", "name", "email", "phone", "city", "role", "sellerType", "contactMethod", "district", "businessName", "license", "bio", "emailVerified", "licenseStatus"];
    const result = {};
    for (const field of fields) result[field] = user[field];
    return result;
}

function reply(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    let text = "";
    for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 3000000) throw new Error("الطلب أكبر من المسموح.");
    }
    return JSON.parse(text || "{}");
}

function getSession(req) {
    const cookie = req.headers.cookie || "";
    const match = cookie.match(/(?:^|;\s*)aqari_session=([a-f0-9]{64})(?:;|$)/);
    if (!match) return null;
    const key = tokenHash(match[1]);
    const session = sessions[key];
    if (!session || session.expires < Date.now()) {
        delete sessions[key];
        return null;
    }
    return { key: key, userId: session.userId };
}

function startSession(res, user, remember) {
    const token = crypto.randomBytes(32).toString("hex");
    const seconds = remember ? 30 * 86400 : 8 * 3600;
    sessions[tokenHash(token)] = { userId: user.id, expires: Date.now() + seconds * 1000 };
    const secure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", "aqari_session=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + seconds + secure);
}

function validateProfile(data) {
    if (typeof data.name !== "string" || data.name.trim().length < 3 || data.name.length > 60) return "أدخل الاسم الكامل.";
    if (typeof data.email !== "string" || data.email.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return "البريد الإلكتروني غير صحيح.";
    if (typeof data.phone !== "string" || !/^(05\d{8}|\+9665\d{8}|9665\d{8})$/.test(data.phone.replace(/[\s-]/g, ""))) return "رقم الجوال غير صحيح.";
    if (!data.city || typeof data.city !== "string" || data.city.length > 60) return "اختر المدينة.";
    if (!["buyer", "seller"].includes(data.role)) return "اختر نوع الحساب.";
    if (data.role === "seller") {
        if (!["owner", "broker", "office"].includes(data.sellerType)) return "اختر صفة البائع.";
        if (!["phone", "whatsapp", "email"].includes(data.contactMethod)) return "اختر طريقة التواصل.";
        if (["broker", "office"].includes(data.sellerType) && (!data.license || !String(data.license).trim())) return "رقم ترخيص فال مطلوب.";
        if (data.sellerType === "office" && (!data.businessName || !String(data.businessName).trim())) return "اسم المكتب مطلوب.";
    }
    for (const field of ["sellerType", "contactMethod", "district", "businessName", "license", "bio"]) {
        if (data[field] !== undefined && (typeof data[field] !== "string" || data[field].length > 500)) return "أحد الحقول غير صحيح.";
    }
    return "";
}

function setProfile(user, data) {
    const oldLicense = user.license;
    const oldName = user.name;
    const oldType = user.sellerType;
    const oldBusiness = user.businessName;
    const fields = ["name", "email", "phone", "city", "role", "sellerType", "contactMethod", "district", "businessName", "license", "bio"];
    for (const field of fields) user[field] = String(data[field] || "").trim();
    user.email = user.email.toLowerCase();
    user.phone = user.phone.replace(/[\s-]/g, "");
    if (user.role !== "seller" || user.sellerType === "owner") user.licenseStatus = "not_required_by_prototype";
    else if (oldLicense !== user.license || oldName !== user.name || oldType !== user.sellerType || oldBusiness !== user.businessName || !user.licenseStatus) user.licenseStatus = "pending";
}

// Email delivery uses Resend only when configured by the project owner.
async function sendEmail(to, subject, text) {
    if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM || !process.env.APP_URL) return false;
    try {
        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject: subject, text: text }),
            signal: AbortSignal.timeout(10000)
        });
        return response.ok;
    } catch (error) { return false; }
}

async function verificationEmail(user) {
    const token = crypto.randomBytes(32).toString("hex");
    user.verifyHash = tokenHash(token);
    user.verifyExpires = Date.now() + 86400000;
    return sendEmail(user.email, "تأكيد البريد الإلكتروني في عقاري", "افتح الرابط لتأكيد بريدك: " + process.env.APP_URL + "/?verify=" + token);
}

async function handleRequest(req, res) {
    // كل شرط أدناه يمثل وظيفة واحدة: التسجيل، الدخول، الخروج أو تعديل الحساب.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;
    if (!route.startsWith("/api/")) {
        if (req.method !== "GET") return reply(res, 405, { error: "الطريقة غير متاحة." });
        const file = route === "/" ? "index.html" : route.slice(1);
        if (file === "config.js") {
            res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
            return res.end('window.AQARI_API_MODE = "mysql";');
        }
        if (!publicFiles.includes(file)) return reply(res, 404, { error: "الصفحة غير موجودة." });
        const types = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", png: "image/png" };
        res.writeHead(200, { "Content-Type": types[file.split(".").pop()], "Cache-Control": "no-store" });
        return res.end(fs.readFileSync(path.join(__dirname, file)));
    }
    try {
        if (req.method === "POST" || req.method === "PUT") {
            if (!(req.headers["content-type"] || "").startsWith("application/json")) return reply(res, 415, { error: "نوع الطلب غير صحيح." });
            const expected = new URL(process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "http://" + req.headers.host)).origin;
            if (req.headers.origin && req.headers.origin !== expected) return reply(res, 403, { error: "مصدر الطلب غير مسموح." });
            const key = req.socket.remoteAddress + ":" + route;
            let rate = attempts[key];
            if (!rate || rate.until < Date.now()) rate = { count: 0, until: Date.now() + 15 * 60000 };
            rate.count++;
            attempts[key] = rate;
            if (rate.count > 30) return reply(res, 429, { error: "محاولات كثيرة. جرّب بعد 15 دقيقة." });
        }
        if (route === "/api/health" && req.method === "GET") {
            await pool.execute("SELECT 1");
            return reply(res, 200, { ok: true, backend: "Node.js + MAMP MySQL" });
        }
        const users = await readUsers();
        const session = getSession(req);
        let user = null;
        if (session) user = findUserById(users, session.userId);
        if (route === "/api/me" && req.method === "GET") return reply(res, 200, { user: user ? publicUser(user) : null });
        if (route === "/api/properties" && req.method === "GET") return reply(res, 200, { properties: await listProperties(user) });
        const data = await readBody(req);
        if (route === "/api/register" && req.method === "POST") {
            const error = validateProfile(data);
            if (error) return reply(res, 400, { error: error });
            if (typeof data.password !== "string" || data.password.length < 10 || data.password.length > 128 || !/[A-Za-z]/.test(data.password) || !/[0-9]/.test(data.password)) return reply(res, 400, { error: "كلمة المرور 10 أحرف على الأقل وتحتوي حروفًا إنجليزية وأرقامًا." });
            if (data.password !== data.confirmPassword) return reply(res, 400, { error: "كلمتا المرور غير متطابقتين." });
            if (data.acceptTerms !== true) return reply(res, 400, { error: "يلزم قبول شروط النسخة التجريبية." });
            if (findUserByEmail(users, data.email.trim().toLowerCase())) return reply(res, 409, { error: "تعذر إنشاء الحساب بهذا البريد؛ جرّب تسجيل الدخول أو استعادة كلمة المرور." });
            const account = { id: crypto.randomUUID(), salt: crypto.randomBytes(16).toString("hex"), emailVerified: false };
            setProfile(account, data);
            account.passwordHash = await passwordHash(data.password);
            const sent = await verificationEmail(account);
            users.push(account);
            await saveUser(account, true);
            startSession(res, account, false);
            return reply(res, 201, { user: publicUser(account), message: sent ? "تم إنشاء الحساب وإرسال رابط تأكيد البريد." : "تم إنشاء الحساب. إرسال تأكيد البريد غير متاح حاليًا؛ إعداد البريد لم يكتمل أو تعذر الإرسال." });
        }
        if (route === "/api/login" && req.method === "POST") {
            if (typeof data.email !== "string" || typeof data.password !== "string" || data.password.length > 128) return reply(res, 400, { error: "أدخل البريد وكلمة المرور." });
            const account = findUserByEmail(users, data.email.trim().toLowerCase());
            // A dummy hash prevents the fast path from revealing unknown emails.
            const candidate = account || { passwordHash: "$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxefPj8e3MY9LhmUu.QpR2m0QvK" };
            if (!await passwordMatches(data.password, candidate) || !account) return reply(res, 401, { error: "البريد أو كلمة المرور غير صحيحة." });
            startSession(res, account, data.remember === true);
            return reply(res, 200, { user: publicUser(account) });
        }
        if (route === "/api/logout" && req.method === "POST") {
            if (session) delete sessions[session.key];
            res.setHeader("Set-Cookie", "aqari_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
            return reply(res, 200, { ok: true });
        }
        if (route === "/api/forgot" && req.method === "POST") {
            if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM || !process.env.APP_URL) return reply(res, 503, { error: "استعادة كلمة المرور تحتاج إعداد خدمة البريد على الخادم." });
            const account = findUserByEmail(users, String(data.email).trim().toLowerCase());
            if (account) {
                const token = crypto.randomBytes(32).toString("hex");
                account.resetHash = tokenHash(token);
                account.resetExpires = Date.now() + 30 * 60000;
                const sent = await sendEmail(account.email, "استعادة كلمة المرور — عقاري", "الرابط صالح 30 دقيقة: " + process.env.APP_URL + "/?reset=" + token);
                if (!sent) return reply(res, 503, { error: "تعذر إرسال رسالة الاستعادة. جرّب لاحقًا." });
                await saveUser(account);
            }
            return reply(res, 200, { message: "إذا كان البريد مسجلًا، سيصله رابط الاستعادة." });
        }
        if (route === "/api/reset" && req.method === "POST") {
            const account = findUserByToken(users, String(data.token), "reset");
            if (!account) return reply(res, 400, { error: "رابط الاستعادة غير صالح أو انتهت صلاحيته." });
            if (typeof data.password !== "string" || data.password.length < 10 || data.password.length > 128 || !/[A-Za-z]/.test(data.password) || !/[0-9]/.test(data.password) || data.password !== data.confirmPassword) return reply(res, 400, { error: "أدخل كلمة مرور قوية ومتطابقة مع التأكيد." });
            account.salt = crypto.randomBytes(16).toString("hex");
            account.passwordHash = await passwordHash(data.password);
            delete account.resetHash;
            delete account.resetExpires;
            for (const key in sessions) {
                if (sessions[key].userId === account.id) delete sessions[key];
            }
            await saveUser(account);
            return reply(res, 200, { message: "تم تغيير كلمة المرور. سجل دخولك من جديد." });
        }
        if (route === "/api/verify-email" && req.method === "POST") {
            const account = findUserByToken(users, String(data.token), "verify");
            if (!account) return reply(res, 400, { error: "رابط التأكيد غير صالح أو انتهت صلاحيته." });
            account.emailVerified = true;
            delete account.verifyHash;
            delete account.verifyExpires;
            await saveUser(account);
            return reply(res, 200, { message: "تم تأكيد البريد الإلكتروني." });
        }
        if (!user) return reply(res, 401, { error: "سجل دخولك أولًا." });
        if (route === "/api/properties" && req.method === "POST") return reply(res, 200, { property: await saveProperty(user, data) });
        if (route === "/api/profile" && req.method === "PUT") {
            data.email = user.email; // Email changes require a separate verified flow.
            const error = validateProfile(data);
            if (error) return reply(res, 400, { error: error });
            setProfile(user, data);
            await saveUser(user);
            return reply(res, 200, { user: publicUser(user) });
        }
        if (route === "/api/resend-email" && req.method === "POST") {
            const sent = await verificationEmail(user);
            await saveUser(user);
            return reply(res, sent ? 200 : 503, sent ? { message: "أرسل رابط التأكيد." } : { error: "خدمة البريد غير مهيأة أو تعذر الإرسال." });
        }
        if (route === "/api/license/verify" && req.method === "POST") {
            // No unofficial endpoint or simulated success. Connect an authorized
            // REGA integration here when the project has access credentials.
            return reply(res, 503, { error: "التحقق الآلي من فال غير مربوط بخدمة رسمية بعد. الرخصة باقية بانتظار التحقق.", officialUrl: officialFalUrl, status: user.licenseStatus });
        }
        return reply(res, 404, { error: "الخدمة غير موجودة." });
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") return reply(res,409,{ error: "البريد مسجل بالفعل. جرّب تسجيل الدخول." });
        if (["ECONNREFUSED","ER_ACCESS_DENIED_ERROR","ER_BAD_DB_ERROR"].includes(error.code)) return reply(res,503,{ error: "تعذر الاتصال بقاعدة البيانات. شغّل MySQL من MAMP وتأكد من إعداد عقاري." });
        return reply(res, error.status || 400, { error: error.status ? error.message : "تعذر تنفيذ الطلب. تحقق من البيانات وحاول مرة أخرى." });
    }
}

if (require.main === module) {
    const server = http.createServer(handleRequest);
    const port = Number(process.env.PORT || 3000);
    server.listen(port, process.env.HOST || "127.0.0.1", function () { console.log("Aqari: http://localhost:" + port); });
}
module.exports = { handleRequest, calculateHash: passwordHash };


} else {

// BROWSER: pages, properties and forms
// بيانات العقارات التجريبية
const properties = [
    {
        "id": 1,
        "name": "Contemporary villa in Al Narjis",
        "ar": "فيلا عصرية في النرجس",
        "city": "Riyadh · Al Narjis",
        "cityAr": "الرياض · النرجس",
        "type": "Villa",
        "tab": "Buy",
        "price": 1000000,
        "beds": 4,
        "baths": 4,
        "area": 320,
        "img": "photo-1600596542815-ffad4c1539a9"
    },
    {
        "id": 2,
        "name": "A home with room to grow",
        "ar": "فيلا واسعة في حي الشاطئ",
        "city": "Jeddah · Al Shati",
        "cityAr": "جدة · الشاطئ",
        "type": "Villa",
        "tab": "Buy",
        "price": 5000000,
        "beds": 5,
        "baths": 6,
        "area": 580,
        "img": "photo-1600607687939-ce8a6c25118c"
    },
    {
        "id": 3,
        "name": "Modern living, thoughtfully designed",
        "ar": "شقة عصرية بتصميم مميز",
        "city": "Riyadh · Al Malqa",
        "cityAr": "الرياض · الملقا",
        "type": "Apartment",
        "tab": "Buy",
        "price": 780000,
        "beds": 3,
        "baths": 3,
        "area": 185,
        "img": "photo-1600566753086-00f18fb6b3ea"
    },
    {
        "id": 4,
        "name": "Your private corner of the city",
        "ar": "تاون هاوس في الياسمين",
        "city": "Riyadh · Al Yasmin",
        "cityAr": "الرياض · الياسمين",
        "type": "Townhouse",
        "tab": "Buy",
        "price": 2400000,
        "beds": 4,
        "baths": 4,
        "area": 290,
        "img": "photo-1600047509807-ba8f99d2cdde"
    },
    {
        "id": 5,
        "name": "Light-filled apartment by the coast",
        "ar": "شقة مضيئة قرب الساحل",
        "city": "Jeddah · Al Rawdah",
        "cityAr": "جدة · الروضة",
        "type": "Apartment",
        "tab": "Buy",
        "price": 950000,
        "beds": 3,
        "baths": 2,
        "area": 210,
        "img": "photo-1600210492486-724fe5c67fb0"
    },
    {
        "id": 6,
        "name": "A new perspective on home",
        "ar": "فيلا بتصميم معاصر",
        "city": "Dammam · Al Faisaliyah",
        "cityAr": "الدمام · الفيصلية",
        "type": "Villa",
        "tab": "Buy",
        "price": 1800000,
        "beds": 4,
        "baths": 5,
        "area": 360,
        "img": "photo-1600607687920-4e2a09cf159d"
    },
    {
        "id": 7,
        "name": "The perfect place to settle in",
        "ar": "شقة للإيجار في الملقا",
        "city": "Riyadh · Al Malqa",
        "cityAr": "الرياض · الملقا",
        "type": "Apartment",
        "tab": "Rent",
        "price": 70000,
        "beds": 3,
        "baths": 2,
        "area": 160,
        "img": "photo-1600210492486-724fe5c67fb0"
    },
    {
        "id": 8,
        "name": "Space, comfort, and a fresh start",
        "ar": "فيلا للإيجار في الشاطئ",
        "city": "Jeddah · Al Shati",
        "cityAr": "جدة · الشاطئ",
        "type": "Villa",
        "tab": "Rent",
        "price": 120000,
        "beds": 4,
        "baths": 4,
        "area": 320,
        "img": "photo-1600596542815-ffad4c1539a9"
    },
    {
        "id": 9,
        "name": "A quieter kind of city living",
        "ar": "تاون هاوس للإيجار",
        "city": "Riyadh · Al Narjis",
        "cityAr": "الرياض · النرجس",
        "type": "Townhouse",
        "tab": "Rent",
        "price": 95000,
        "beds": 3,
        "baths": 3,
        "area": 230,
        "img": "photo-1600047509807-ba8f99d2cdde"
    },
    {
        "id": 10,
        "name": "Al Narjis Residences",
        "ar": "مشروع مساكن النرجس",
        "city": "Riyadh · Al Narjis",
        "cityAr": "الرياض · النرجس",
        "type": "Villa",
        "tab": "Projects",
        "price": 2000000,
        "beds": 4,
        "baths": 4,
        "area": 300,
        "img": "photo-1600607687939-ce8a6c25118c"
    },
    {
        "id": 11,
        "name": "Coastal Living Collection",
        "ar": "مشروع مساكن الساحل",
        "city": "Jeddah · Al Shati",
        "cityAr": "جدة · الشاطئ",
        "type": "Apartment",
        "tab": "Projects",
        "price": 1500000,
        "beds": 3,
        "baths": 3,
        "area": 220,
        "img": "photo-1600566753086-00f18fb6b3ea"
    }
];

// بيانات العقارات التجريبية تُضاف في بداية هذا الملف.

// أمثلة البنوك المنشورة، وليست عروضًا شخصية للمستخدم.
const banks = [
    {
        id: "snb",
        name: "البنك الأهلي السعودي",
        shortName: "SNB",
        apr: 5.71,
        years: 25,
        phone: "8002441005",
        logo: "",
        website: "https://www.alahli.com/en/pages/residential-finance-form",
        source: "https://www.alahli.com/ar/pages/personal-banking/finance/finance-and-saving-pricing-residential-finance"
    },
    {
        id: "riyad",
        name: "بنك الرياض",
        shortName: "RIYAD",
        apr: 6.90,
        years: 25,
        phone: "8001242225",
        logo: "https://www.riyadbank.com/documents/56211/7527405/riyad-bank-with-text-logo.svg/44e4f9e9-8330-9fcb-e845-a55fccde7681?t=1759241449610&download=true",
        website: "https://www.riyadbank.com/personal-banking/home-finance",
        source: "https://www.riyadbank.com/information/special-pages/arp-disclosure"
    },
    {
        id: "saib",
        name: "البنك السعودي للاستثمار",
        shortName: "SAIB",
        apr: 6.44,
        years: 15,
        phone: "8001248000",
        logo: "https://www.saib.com.sa/sites/default/files/2025-09/saib-logo1.png",
        website: "https://www.saib.com.sa/en/al-asalahmurabahahomefinance",
        source: "https://www.saib.com.sa/en/al-asalahmurabahahomefinance"
    }
];

// متغيرات نحتاجها أثناء استخدام الموقع.
let currentUser = null;
let savedProperties = readStorage("aqari-saved", []);
const phpBackend = window.AQARI_API_MODE === "php" && !window.location.hostname.endsWith(".github.io");
const databaseBackend = phpBackend || window.AQARI_API_MODE === "mysql";
let sellerProperties = databaseBackend ? [] : readStorage("aqari-student-ads", []);
let favoritesOnly = false;
let editingId = null;
let currentProperty = null;
let selectedBankId = "snb";
let messageTimer;

if (!Array.isArray(savedProperties)) savedProperties = [];
if (!Array.isArray(sellerProperties)) sellerProperties = [];

// نضيف إعلانات البائع المحفوظة إلى قائمة العقارات.
for (let i = 0; i < sellerProperties.length; i++) {
    properties.push(sellerProperties[i]);
}

// دوال مساعدة بسيطة.
function getElement(id) {
    return document.getElementById(id);
}

function readStorage(key, defaultValue) {
    try {
        const text = localStorage.getItem(key);
        if (text) return JSON.parse(text);
    } catch (error) {
        console.log("تعذر قراءة البيانات المحلية");
    }
    return defaultValue;
}

function saveStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        showMessage("تعذر الحفظ على هذا المتصفح. قد تكون مساحة التخزين ممتلئة.");
    }
}

function formatMoney(number) {
    return Math.round(number).toLocaleString("en-US") + " ر.س";
}

// نحول النص قبل وضعه في HTML حتى لا يتحول إدخال المستخدم إلى كود.
function safeText(text) {
    const element = document.createElement("span");
    element.textContent = text;
    return element.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function showMessage(text) {
    clearTimeout(messageTimer);
    getElement("message").textContent = text;
    getElement("message").hidden = false;
    messageTimer = setTimeout(function () {
        getElement("message").hidden = true;
    }, 3000);
}

function getPhoto(property) {
    if (property.photo) return property.photo;
    return "https://images.unsplash.com/" + property.img + "?auto=format&fit=crop&w=1000&q=80";
}

function getPurpose(purpose) {
    if (purpose === "Rent") return "للإيجار";
    if (purpose === "Projects") return "مشروع جديد";
    return "للبيع";
}

function findProperty(id) {
    for (let i = 0; i < properties.length; i++) {
        if (properties[i].id === id) return properties[i];
    }
    return null;
}

// البحث والتصفية ثم عرض البطاقات.
function showProperties() {
    const search = getElement("searchInput").value.trim().toLowerCase();
    const city = getElement("cityInput").value;
    const purpose = getElement("purposeInput").value;
    const type = getElement("typeInput").value;
    const maxPrice = Number(getElement("priceInput").value);
    const minArea = Number(getElement("areaInput").value);
    const minBeds = Number(getElement("bedroomsInput").value);
    let results = [];

    for (let i = 0; i < properties.length; i++) {
        const property = properties[i];
        const searchText = (property.ar + " " + property.cityAr + " " + property.name + " " + property.city).toLowerCase();
        if (property.paused) continue;
        if (search && !searchText.includes(search)) continue;
        if (city && !property.cityAr.includes(city)) continue;
        if (purpose && property.tab !== purpose) continue;
        if (type && property.type !== type) continue;
        if (maxPrice > 0 && property.price > maxPrice) continue;
        if (property.area < minArea || property.beds < minBeds) continue;
        if (favoritesOnly && !savedProperties.includes(property.id)) continue;
        results.push(property);
    }

    const sort = getElement("sortInput").value;
    results.sort(function (a, b) {
        if (sort === "low") return a.price - b.price;
        if (sort === "high") return b.price - a.price;
        if (sort === "area") return b.area - a.area;
        return b.id - a.id;
    });

    let cards = "";
    for (let i = 0; i < results.length; i++) {
        const property = results[i];
        let heart = "♡";
        if (savedProperties.includes(property.id)) heart = "♥";
        let period = "";
        if (property.tab === "Rent") period = " / سنوي";
        cards += `
            <article class="property-card">
                <div class="card-photo">
                    <button class="photo-button" data-details="${property.id}" aria-label="تفاصيل العقار">
                        <img src="${safeText(getPhoto(property))}" alt="${safeText(property.ar)}" loading="lazy">
                    </button>
                    <span class="badge">${getPurpose(property.tab)}</span>
                    <button class="save-button" data-save="${property.id}" aria-label="حفظ العقار" aria-pressed="${savedProperties.includes(property.id)}">${heart}</button>
                </div>
                <div class="card-body">
                    <div class="card-price">${formatMoney(property.price)}${period}</div>
                    <button class="card-title" data-details="${property.id}">${safeText(property.ar)}</button>
                    <p class="card-city">⌖ ${safeText(property.cityAr)}</p>
                    <div class="facts"><span>${property.beds} غرف</span><span>${property.baths} حمامات</span><span>${property.area} م²</span></div>
                    <div class="card-bottom"><span>إعلان تجريبي</span><button data-details="${property.id}">التفاصيل ${property.tab === "Rent" ? "" : "والتمويل"} ←</button></div>
                </div>
            </article>`;
    }
    getElement("propertyList").innerHTML = cards;
    getElement("resultCount").textContent = results.length + " عقار · بيانات توضيحية";
    getElement("emptyMessage").hidden = results.length !== 0;
    let title = "عقارات للبيع والإيجار";
    if (purpose === "Buy") title = "عقارات للبيع";
    if (purpose === "Rent") title = "عقارات للإيجار";
    if (purpose === "Projects") title = "المشاريع الجديدة";
    if (favoritesOnly) title = "عقاراتك المفضلة";
    getElement("listTitle").textContent = title;
    document.querySelectorAll("[data-property-type]").forEach(function (button) {
        const active = button.dataset.propertyType === type;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
    });
    document.querySelectorAll("[data-city]").forEach(function (button) {
        button.classList.toggle("active", button.dataset.city === city);
    });
    getElement("favoritesButton").setAttribute("aria-pressed", String(favoritesOnly));
    updateNavigation();
}

// نستخدم فلتر نوع العرض نفسه بدل إنشاء صفحات أو منطق إضافي.
function openPropertySection(purpose) {
    favoritesOnly = false;
    getElement("purposeInput").value = purpose;
    showBuyerPage();
}

function updateNavigation() {
    const purpose = getElement("purposeInput").value;
    const sellerWorkspace = Boolean(currentUser && currentUser.role === "seller" && getElement("buyerPage").hidden);
    getElement("browsePropertiesButton").hidden = !sellerWorkspace;
    getElement("favoritesButton").hidden = sellerWorkspace;
    getElement("addListingButton").hidden = !currentUser || currentUser.role !== "seller" || sellerWorkspace;
    getElement("myListingsNav").classList.toggle("active", sellerWorkspace && !getElement("sellerPage").hidden);
    document.querySelector("header").classList.toggle("seller-workspace", sellerWorkspace);
    const buttons = ["saleButton", "rentButton", "projectsButton"];
    const purposes = ["Buy", "Rent", "Projects"];
    for (let i = 0; i < buttons.length; i++) {
        getElement(buttons[i]).hidden = sellerWorkspace;
        const active = !favoritesOnly && !getElement("buyerPage").hidden && purpose === purposes[i];
        getElement(buttons[i]).classList.toggle("active", active);
        getElement(buttons[i]).setAttribute("aria-pressed", active);
    }
}

function toggleFavorite(id) {
    const index = savedProperties.indexOf(id);
    if (index === -1) savedProperties.push(id);
    else savedProperties.splice(index, 1);
    saveStorage("aqari-saved", savedProperties);
    showProperties();
}

function resetFilters() {
    const inputs = ["searchInput", "cityInput", "purposeInput", "typeInput", "priceInput", "areaInput"];
    for (let i = 0; i < inputs.length; i++) getElement(inputs[i]).value = "";
    getElement("bedroomsInput").value = "0";
    favoritesOnly = false;
    showProperties();
}

function chooseCategory(type) {
    getElement("typeInput").value = type;
    showProperties();
}

// الدخول التجريبي: نحفظ الاسم ونوع المستخدم فقط.
function showBuyerPage() {
    getElement("accountDialog").hidden = true;
    getElement("buyerPage").hidden = false;
    getElement("sellerPage").hidden = true;
    showProperties();
}

function updateUserPage() {
    const isSeller = currentUser && currentUser.role === "seller";
    getElement("myListingsNav").hidden = !isSeller;
    getElement("addListingButton").hidden = !isSeller;
    if (currentUser) {
        let roleName = "مشتري";
        if (currentUser.role === "seller") roleName = "بائع";
        getElement("accountButton").textContent = "حسابي · " + currentUser.name;
        if (currentUser.role === "seller") showSellerPage();
        else showBuyerPage();
    } else {
        getElement("accountButton").textContent = "دخول / تسجيل";
        showBuyerPage();
    }
}

// طلبات الحساب تُرسل إلى الخادم، وليس إلى localStorage.
let editingProfile = false;
let resetToken = new URLSearchParams(window.location.search).get("reset");

async function apiRequest(url, method, data) {
    if (window.location.hostname.endsWith(".github.io")) {
        if (url === "/api/me") return { user: null };
        throw new Error("خدمات الحسابات غير متاحة في نسخة العرض الحالية. يمكنك تصفح العقارات وحفظ المفضلة ومقارنة تقديرات التمويل.");
    }
    // fetch يرسل طلبًا للخادم، وawait ينتظر الرد قبل تنفيذ السطر التالي.
    if (window.location.protocol === "file:") throw new Error("شغّل المشروع باستخدام node script.js وافتح http://localhost:3000. تسجيل الحساب لا يعمل بفتح ملف HTML مباشرة.");
    const options = { method: method, credentials: "same-origin" };
    if (data) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(data);
    }
    let response;
    const endpoint = phpBackend ? "api.php?route=" + encodeURIComponent(url.replace(/^\/api\//, "")) : url;
    try { response = await fetch(endpoint, options); }
    catch (error) { throw new Error("تعذر الاتصال بخادم المشروع. تأكد من تشغيل node script.js."); }
    if (!(response.headers.get("Content-Type") || "").includes("application/json")) throw new Error("خادم الحسابات غير جاهز. افتح الموقع من خادم MAMP وتأكد من تشغيل PHP وMySQL.");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "تعذر تنفيذ الطلب.");
    return result;
}

function getProfileData() {
    return {
        name: getElement("nameInput").value.trim(),
        email: getElement("emailInput").value.trim(),
        phone: getElement("phoneInput").value.replace(/[\s-]/g, ""),
        city: getElement("userCityInput").value,
        role: document.querySelector('input[name="role"]:checked').value,
        sellerType: getElement("sellerTypeInput").value,
        contactMethod: getElement("contactMethodInput").value,
        district: getElement("sellerDistrictInput").value.trim(),
        businessName: getElement("businessNameInput").value.trim(),
        license: getElement("licenseInput").value.trim(),
        bio: getElement("sellerBioInput").value.trim()
    };
}

function setRegistrationMode(isEdit) {
    editingProfile = isEdit;
    getElement("registrationPasswords").hidden = isEdit;
    getElement("registerPassword").disabled = isEdit;
    getElement("confirmPassword").disabled = isEdit;
    getElement("termsInput").disabled = isEdit;
    getElement("emailInput").readOnly = isEdit;
    getElement("returnSignIn").hidden = isEdit;
    if (isEdit) {
        getElement("registrationTitle").textContent = "تعديل معلومات الحساب";
        getElement("registrationSubmit").textContent = "حفظ التعديلات";
    } else {
        getElement("registrationTitle").textContent = "إنشاء حساب جديد";
        getElement("registrationSubmit").textContent = "إنشاء الحساب";
    }
    getElement("profileError").hidden = true;
}

getElement("loginForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    const button = getElement("registrationSubmit");
    button.disabled = true;
    getElement("profileError").hidden = true;
    try {
        const data = getProfileData();
        data.password = getElement("registerPassword").value;
        data.confirmPassword = getElement("confirmPassword").value;
        data.acceptTerms = getElement("termsInput").checked;
        let url = "/api/register";
        let method = "POST";
        if (editingProfile) {
            url = "/api/profile";
            method = "PUT";
        }
        const result = await apiRequest(url, method, data);
        currentUser = result.user;
        getElement("registerPassword").value = "";
        getElement("confirmPassword").value = "";
        getElement("loginDialog").close();
        if (databaseBackend) await loadServerProperties();
        updateUserPage();
        showMessage(result.message || "تم حفظ معلومات الحساب.");
    } catch (error) {
        getElement("profileError").textContent = error.message;
        getElement("profileError").hidden = false;
    }
    button.disabled = false;
});

getElement("signInForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"], button.primary');
    button.disabled = true;
    getElement("signInError").hidden = true;
    try {
        const result = await apiRequest("/api/login", "POST", {
            email: getElement("signInEmail").value,
            password: getElement("signInPassword").value,
            remember: getElement("rememberInput").checked
        });
        currentUser = result.user;
        getElement("signInPassword").value = "";
        getElement("signInDialog").close();
        if (databaseBackend) await loadServerProperties();
        updateUserPage();
    } catch (error) {
        getElement("signInError").textContent = error.message;
        getElement("signInError").hidden = false;
    }
    button.disabled = false;
});

getElement("accountButton").addEventListener("click", function () {
    if (window.location.hostname.endsWith(".github.io")) {
        showMessage("هذه نسخة عرض عامة. تسجيل الدخول وإضافة الإعلانات يحتاجان ربط خادم الحسابات.");
        return;
    }
    if (!currentUser) {
        getElement("signInError").hidden = true;
        getElement("signInDialog").showModal();
        return;
    }
    getElement("accountName").textContent = currentUser.name;
    getElement("accountRole").textContent = "نوع الحساب: " + (currentUser.role === "seller" ? "بائع" : "مشتري");
    showProfileSummary();
    getElement("buyerPage").hidden = true;
    getElement("sellerPage").hidden = true;
    getElement("accountDialog").hidden = false;
    getElement("sellerAccountSection").hidden = currentUser.role !== "seller";
    getElement("startSellingSection").hidden = currentUser.role === "seller";
    setPersonalEditing(false);
    updateNavigation();
    window.scrollTo(0, 0);
});

getElement("switchButton").addEventListener("click", function () {
    openProfileForm("seller");
});

getElement("logoutButton").addEventListener("click", async function () {
    try {
        await apiRequest("/api/logout", "POST", {});
        currentUser = null;
        if (databaseBackend) await loadServerProperties();
        getElement("accountDialog").hidden = true;
        updateUserPage();
    } catch (error) { showMessage(error.message); }
});

getElement("createAccountButton").addEventListener("click", function () {
    getElement("signInDialog").close();
    openProfileForm("buyer");
});
getElement("returnSignInButton").addEventListener("click", function () {
    getElement("loginDialog").close();
    getElement("signInDialog").showModal();
});

getElement("forgotButton").addEventListener("click", function () {
    resetToken = null;
    getElement("signInDialog").close();
    getElement("recoveryTitle").textContent = "استعادة كلمة المرور";
    getElement("recoveryEmailLabel").hidden = false;
    getElement("recoveryEmail").disabled = false;
    getElement("resetFields").hidden = true;
    getElement("resetPassword").disabled = true;
    getElement("resetConfirm").disabled = true;
    getElement("recoveryMessage").textContent = "اكتب البريد المسجل لإرسال رابط الاستعادة. يلزم إعداد البريد على الخادم.";
    getElement("recoveryDialog").showModal();
});

getElement("recoveryForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    try {
        const data = resetToken ? { token: resetToken, password: getElement("resetPassword").value, confirmPassword: getElement("resetConfirm").value } : { email: getElement("recoveryEmail").value };
        const result = await apiRequest(resetToken ? "/api/reset" : "/api/forgot", "POST", data);
        getElement("recoveryMessage").textContent = result.message;
        if (resetToken) {
            getElement("recoveryDialog").close();
            getElement("signInDialog").showModal();
            showMessage(result.message);
            history.replaceState(null, "", "/");
        }
    } catch (error) { getElement("recoveryMessage").textContent = error.message; }
});

getElement("verifyLicenseButton").addEventListener("click", async function () {
    if (!currentUser || getElement("licenseInput").value.trim() !== currentUser.license) {
        getElement("licenseCheckMessage").textContent = "أنشئ الحساب أو احفظ رقم الترخيص أولًا. لا يعتبر الترخيص موثّقًا قبل التحقق الرسمي.";
        return;
    }
    try {
        await apiRequest("/api/license/verify", "POST", {});
    } catch (error) { getElement("licenseCheckMessage").textContent = error.message; }
});

getElement("resendEmailButton").addEventListener("click", async function () {
    try { const result = await apiRequest("/api/resend-email", "POST", {}); showMessage(result.message); }
    catch (error) { showMessage(error.message); }
});

document.addEventListener("click", function (event) {
    const button = event.target.closest("[data-password]");
    if (!button) return;
    const input = getElement(button.dataset.password);
    input.type = input.type === "password" ? "text" : "password";
    button.textContent = input.type === "password" ? "إظهار" : "إخفاء";
});

getElement("registerPassword").addEventListener("input", function () {
    const password = getElement("registerPassword").value;
    const valid = password.length >= 10 && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
    getElement("passwordStrength").textContent = valid ? "تستوفي كلمة المرور الحد الأدنى المطلوب." : "10 أحرف على الأقل، مع حروف إنجليزية وأرقام.";
});

async function loadSession() {
    try {
        const params = new URLSearchParams(window.location.search);
        const verifyToken = params.get("verify");
        if (verifyToken) {
            const result = await apiRequest("/api/verify-email", "POST", { token: verifyToken });
            showMessage(result.message);
            history.replaceState(null, "", "/");
        }
        const result = await apiRequest("/api/me", "GET");
        currentUser = result.user;
        if (databaseBackend) await loadServerProperties();
        updateUserPage();
        if (resetToken) {
            getElement("recoveryTitle").textContent = "تعيين كلمة مرور جديدة";
            getElement("recoveryEmailLabel").hidden = true;
            getElement("recoveryEmail").disabled = true;
            getElement("resetFields").hidden = false;
            getElement("resetPassword").disabled = false;
            getElement("resetPassword").required = true;
            getElement("resetConfirm").disabled = false;
            getElement("resetConfirm").required = true;
            getElement("recoveryDialog").showModal();
        }
    } catch (error) { showMessage(error.message); }
}


function showSellerPage() {
    if (!currentUser || currentUser.role !== "seller") return;
    getElement("accountDialog").hidden = true;
    getElement("buyerPage").hidden = true;
    getElement("sellerPage").hidden = false;
    getElement("sellerOverview").hidden = false;
    updateNavigation();
    getElement("welcomeText").textContent = "مرحبًا، " + currentUser.name;
    let total = 0;
    let active = 0;
    let content = "";
    for (let i = 0; i < properties.length; i++) {
        const property = properties[i];
        if (!property.owner || property.ownerId !== currentUser.id) continue;
        total++;
        if (!property.paused) active++;
        content += `
            <article class="seller-ad">
                <img src="${safeText(getPhoto(property))}" alt="${safeText(property.ar)}">
                <div><h3>${safeText(property.ar)}</h3><p>${safeText(property.cityAr)} · ${formatMoney(property.price)}</p><p>${property.paused ? "موقوف" : "نشط"}</p></div>
                <div class="ad-actions">
                    <button class="outline" data-edit="${property.id}">تعديل</button>
                    <button class="outline" data-pause="${property.id}">${property.paused ? "تفعيل" : "إيقاف"}</button>
                    <button class="outline" data-details="${property.id}">معاينة</button>
                </div>
            </article>`;
    }
    if (total === 0) content = '<div class="empty"><h2>ما عندك إعلانات حتى الآن</h2><p>ابدأ بإضافة عقارك الأول من زر «أضف عقار».</p></div>';
    getElement("sellerList").innerHTML = content;
    getElement("totalAds").textContent = total;
    getElement("activeAds").textContent = active;
    getElement("pausedAds").textContent = total - active;
    getElement("propertyFormPanel").hidden = true;
}

function saveSellerProperties() {
    sellerProperties = [];
    for (let i = 0; i < properties.length; i++) {
        if (properties[i].owner) sellerProperties.push(properties[i]);
    }
    saveStorage("aqari-student-ads", sellerProperties);
}

function openAdForm(id) {
    if (!currentUser || currentUser.role !== "seller") {
        openProfileForm("seller");
        return;
    }
    if (id && findProperty(id).ownerId !== currentUser.id) return;
    getElement("adForm").reset();
    editingId = id;
    getElement("adTitle").textContent = id ? "تعديل بيانات العقار" : "أكمل بيانات عقارك";
    if (id) {
        const property = findProperty(id);
        getElement("adName").value = property.ar;
        const location = property.cityAr.split(" · ");
        getElement("adCity").value = location[0];
        getElement("adDistrict").value = location[1] || "";
        getElement("adType").value = property.type;
        getElement("adPurpose").value = property.tab;
        getElement("adPrice").value = property.price;
        getElement("adArea").value = property.area;
        getElement("adBeds").value = property.beds;
        getElement("adBaths").value = property.baths;
        getElement("adDescription").value = property.description || "";
        getElement("adStreet").value = property.street || "";
        getElement("adAge").value = property.age === undefined ? "" : property.age;
        getElement("adDirection").value = property.direction || "";
        getElement("adFloor").value = property.floor || "";
        getElement("adFurnished").value = property.furnished || "غير مؤثث";
        getElement("adStreetWidth").value = property.streetWidth || "";
        getElement("adPermit").value = property.permit || "";
        const featureIds = ["adParking", "adElevator", "adAC", "adKitchen", "adGarden", "adBalcony"];
        for (let i = 0; i < featureIds.length; i++) {
            getElement(featureIds[i]).checked = Boolean(property.features && property.features.includes(featureIds[i]));
        }
    }
    getElement("propertyFormPanel").hidden = false;
    getElement("sellerOverview").hidden = true;
    getElement("buyerPage").hidden = true;
    getElement("accountDialog").hidden = true;
    getElement("sellerPage").hidden = false;
    updateNavigation();
    window.scrollTo(0, 0);
}

getElement("adForm").addEventListener("submit", function (event) {
    event.preventDefault();
    const photo = getElement("adPhoto").files[0];
    if (photo) {
        const validTypes = ["image/jpeg", "image/png", "image/webp"];
        if (photo.size > 2 * 1024 * 1024 || !validTypes.includes(photo.type)) {
            showMessage("اختاري صورة JPG أو PNG أو WebP أقل من 2 ميجابايت.");
            return;
        }
        const reader = new FileReader();
        reader.onload = function () { saveAd(reader.result); };
        reader.onerror = function () { showMessage("تعذر قراءة الصورة."); };
        reader.readAsDataURL(photo);
    } else {
        saveAd("");
    }
});

async function saveAd(photo) {
    const submitButton = getElement("adForm").querySelector("button.primary");
    if (submitButton.disabled) return;
    submitButton.disabled = true;
    try {
    const existing = editingId ? findProperty(editingId) : null;
    let property = existing ? { ...existing } : null;
    if (!property) {
        property = { id: Date.now(), owner: true, ownerId: currentUser.id, paused: false, img: "photo-1600596542815-ffad4c1539a9" };
    }
    property.ar = getElement("adName").value.trim();
    property.name = property.ar;
    property.cityAr = getElement("adCity").value + " · " + getElement("adDistrict").value.trim();
    property.city = property.cityAr;
    property.type = getElement("adType").value;
    property.tab = getElement("adPurpose").value;
    property.price = Number(getElement("adPrice").value);
    property.area = Number(getElement("adArea").value);
    property.beds = Number(getElement("adBeds").value);
    property.baths = Number(getElement("adBaths").value);
    property.description = getElement("adDescription").value.trim();
    property.street = getElement("adStreet").value.trim();
    property.age = Number(getElement("adAge").value);
    property.direction = getElement("adDirection").value;
    property.floor = getElement("adFloor").value;
    property.furnished = getElement("adFurnished").value;
    property.streetWidth = getElement("adStreetWidth").value ? Number(getElement("adStreetWidth").value) : null;
    property.permit = getElement("adPermit").value.trim();
    property.features = [];
    const featureIds = ["adParking", "adElevator", "adAC", "adKitchen", "adGarden", "adBalcony"];
    for (let i = 0; i < featureIds.length; i++) {
        if (getElement(featureIds[i]).checked) property.features.push(featureIds[i]);
    }
    const needsVerification = (currentUser.sellerType === "broker" || currentUser.sellerType === "office") && currentUser.licenseStatus !== "verified";
    if (needsVerification) property.paused = true;
    property.draft = needsVerification;
    if (photo) property.photo = photo;
    if (databaseBackend) {
        await apiRequest("/api/properties", "POST", { id: editingId || null, property: property });
        await loadServerProperties();
    } else {
        if (existing) Object.assign(existing, property);
        else properties.push(property);
        saveSellerProperties();
    }
    getElement("propertyFormPanel").hidden = true;
    showSellerPage();
    showMessage(databaseBackend ? "تم حفظ العقار على الخادم." : "تم حفظ الإعلان التجريبي.");
    } catch (error) { showMessage(error.message); }
    finally { submitButton.disabled = false; }
}

async function loadServerProperties() {
    const result = await apiRequest("/api/properties", "GET");
    for (let i = properties.length - 1; i >= 0; i--) {
        if (properties[i].owner) properties.splice(i, 1);
    }
    properties.push(...result.properties);
}

// تفاصيل العقار تظهر في نافذة واحدة، وتحتها خيارات البنوك.
function showDetails(id) {
    currentProperty = findProperty(id);
    if (!currentProperty) return;
    const property = currentProperty;
    getElement("detailsImage").src = getPhoto(property);
    getElement("detailsImage").alt = property.ar;
    getElement("detailsName").textContent = property.ar;
    getElement("detailsCity").textContent = property.cityAr;
    getElement("detailsPurpose").textContent = getPurpose(property.tab);
    getElement("detailsPrice").textContent = formatMoney(property.price) + (property.tab === "Rent" ? " / سنوي" : "");
    getElement("detailsFacts").textContent = property.beds + " غرف  ·  " + property.baths + " دورات مياه  ·  " + property.area + " م²";
    getElement("detailsDescription").textContent = property.description || "عقار توضيحي لاستعراض تجربة الموقع. الصور والأسعار والمواصفات ليست إعلانًا حقيقيًا.";
    showExtraPropertyDetails(property);
    getElement("financeSection").hidden = property.tab === "Rent";
    getElement("downInput").value = "10";
    getElement("termInput").value = "source";
    selectedBankId = "snb";
    if (property.tab !== "Rent") showBanks();
    getElement("detailsDialog").showModal();
}

// حساب القسط التقريبي بأقساط متساوية.
// APR هنا مرجع للمحاكاة، وقد يختلف عن معدل الربح في عقد البنك.
function calculateFinance(price, downPercent, years, apr) {
    // نحسب الدفعة الأولى، ثم مبلغ التمويل، ثم القسط الشهري.
    const downPayment = price * downPercent / 100;
    const amount = price - downPayment;
    const months = years * 12;
    const monthlyRate = Math.pow(1 + apr / 100, 1 / 12) - 1;
    let installment = amount / months;
    if (monthlyRate > 0) {
        installment = amount * monthlyRate / (1 - Math.pow(1 + monthlyRate, -months));
    }
    return { amount: amount, downPayment: downPayment, installment: installment, total: installment * months };
}

function showBanks() {
    const downPercent = Number(getElement("downInput").value);
    if (downPercent < 10 || downPercent > 95 || !Number.isFinite(downPercent)) {
        showMessage("الدفعة الأولى لازم تكون بين 10% و95%.");
        return;
    }
    let content = "";
    for (let i = 0; i < banks.length; i++) {
        const bank = banks[i];
        let years = bank.years;
        if (getElement("termInput").value !== "source") years = Number(getElement("termInput").value);
        const result = calculateFinance(currentProperty.price, downPercent, years, bank.apr);
        const isSelected = bank.id === selectedBankId;
        let logo = bank.shortName;
        if (bank.logo) logo = `<img src="${bank.logo}" alt="شعار ${bank.name}" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>${bank.shortName}</span>`;
        let fees = "تُؤكد لدى البنك";
        if (bank.id === "saib") fees = formatMoney(Math.min(result.amount * 0.01, 5000)) + " دون الضريبة";
        content += `
            <article class="bank-option ${isSelected ? "selected" : ""}">
                <label class="bank-choice">
                    <input type="radio" name="bank" value="${bank.id}" ${isSelected ? "checked" : ""}>
                    <span class="bank-logo">${logo}</span>
                    <span class="bank-name"><strong>${bank.name}</strong><small>APR مرجعي ${bank.apr.toFixed(2)}% · تقديري</small></span>
                    <span class="bank-payment"><strong>${formatMoney(result.installment)}</strong><small>قسط شهري تقريبي</small></span>
                </label>
                <div class="bank-details" ${isSelected ? "" : "hidden"}>
                    <div class="bank-numbers">
                        <div><span>مبلغ التمويل المفترض</span><strong>${formatMoney(result.amount)}</strong></div>
                        <div><span>الدفعة الأولى (${downPercent}%)</span><strong>${formatMoney(result.downPayment)}</strong></div>
                        <div><span>مدة المحاكاة</span><strong>${years} سنة</strong></div>
                        <div><span>مجموع الأقساط التقريبي</span><strong>${formatMoney(result.total)}</strong></div>
                        <div><span>الرسوم الإدارية</span><strong>${fees}</strong></div>
                        <div><span>رقم ممثل مخصص</span><strong>غير متوفر؛ تواصل عبر البنك</strong></div>
                    </div>
                    <p class="note">القسط مبني على معدل شهري مكافئ لـAPR المنشور. مجموع الأقساط لا يشمل الدفعة الأولى، ولا تُضاف الرسوم منفصلة للمحاكاة. الاستحقاق والتسعير النهائي يحددهما البنك.</p>
                    <div class="bank-links">
                        <a class="primary" href="${bank.website}" target="_blank" rel="noopener noreferrer">زيارة البنك مباشرة ↗</a>
                        <a class="outline" href="tel:${bank.phone}">اتصال: <bdi>${bank.phone}</bdi></a>
                        <a class="source-link" href="${bank.source}" target="_blank" rel="noopener noreferrer">مصدر التسعير</a>
                    </div>
                    <p class="note">الرقم قناة رسمية عامة للبنك، وليس رقم ممثل معيّن. الأمثلة راجعت بتاريخ 15 نوفمبر 2026.</p>
                </div>
            </article>`;
    }
    getElement("bankList").innerHTML = content;
}

// ربط الأزرار بالدوال.
getElement("searchForm").addEventListener("submit", function (event) {
    event.preventDefault();
    showProperties();
});
getElement("sortInput").addEventListener("change", showProperties);
getElement("typeInput").addEventListener("change", showProperties);
getElement("purposeInput").addEventListener("change", showProperties);
getElement("filterButton").addEventListener("click", function () {
    getElement("filters").hidden = !getElement("filters").hidden;
});
getElement("resetButton").addEventListener("click", resetFilters);
getElement("calculateButton").addEventListener("click", showBanks);
getElement("allCategory").addEventListener("click", function () {
    chooseCategory("");
});
getElement("villaCategory").addEventListener("click", function () {
    chooseCategory("Villa");
});
getElement("townhouseCategory").addEventListener("click", function () {
    chooseCategory("Townhouse");
});
getElement("apartmentCategory").addEventListener("click", function () {
    chooseCategory("Apartment");
});
getElement("saleButton").addEventListener("click", function () {
    openPropertySection("Buy");
});
getElement("rentButton").addEventListener("click", function () {
    openPropertySection("Rent");
});
getElement("projectsButton").addEventListener("click", function () {
    openPropertySection("Projects");
});
getElement("favoritesButton").addEventListener("click", function () {
    resetFilters(); favoritesOnly = true; showBuyerPage();
    getElement("explore").scrollIntoView({ behavior: "smooth" });
});

getElement("addListingButton").addEventListener("click", function () {
    if (currentUser && currentUser.role === "seller") {
        showSellerPage();
        openAdForm();
    } else {
        openProfileForm("seller");
    }
});
getElement("browsePropertiesButton").addEventListener("click", showBuyerPage);
getElement("dashboardAddButton").addEventListener("click", function () { openAdForm(null); });
getElement("backToListingsButton").addEventListener("click", showSellerPage);
getElement("cancelAdButton").addEventListener("click", showSellerPage);

function setListingView(listView) {
    getElement("propertyList").classList.toggle("list-view", listView);
    getElement("gridViewButton").classList.toggle("active", !listView);
    getElement("listViewButton").classList.toggle("active", listView);
    getElement("gridViewButton").setAttribute("aria-pressed", String(!listView));
    getElement("listViewButton").setAttribute("aria-pressed", String(listView));
}
getElement("gridViewButton").addEventListener("click", function () { setListingView(false); });
getElement("listViewButton").addEventListener("click", function () { setListingView(true); });
document.querySelectorAll("[data-city]").forEach(function (button) {
    button.addEventListener("click", function () {
        getElement("cityInput").value = button.dataset.city;
        showProperties();
    });
});
getElement("exploreFinanceButton").addEventListener("click", function () {
    const property = properties.find(function (item) { return item.tab === "Buy" && !item.paused; });
    if (property) {
        showDetails(property.id);
        getElement("financeSection").scrollIntoView({ behavior: "smooth" });
    }
});
getElement("copyrightYear").textContent = new Date().getFullYear();

// البطاقات تُنشأ بالجافاسكربت، لذلك نتابع أزرارها من الصفحة.
document.addEventListener("click", async function (event) {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.close) getElement(button.dataset.close).close();
    if (button.dataset.details) showDetails(Number(button.dataset.details));
    if (button.dataset.save) toggleFavorite(Number(button.dataset.save));
    if (currentUser && currentUser.role === "seller") {
        if (button.dataset.edit) openAdForm(Number(button.dataset.edit));
        if (button.dataset.pause) {
            const property = findProperty(Number(button.dataset.pause));
            if (property && property.owner && property.ownerId === currentUser.id) {
                const waiting = (currentUser.sellerType === "broker" || currentUser.sellerType === "office") && currentUser.licenseStatus !== "verified";
                if (waiting && property.paused) {
                    showMessage("بيانات العقار محفوظة كمسودة. التفعيل يحتاج التحقق الرسمي من ترخيص فال.");
                    return;
                }
                try {
                    if (databaseBackend) {
                        button.disabled = true;
                        await apiRequest("/api/properties", "POST", { id: property.id, property: { ...property, paused: !property.paused } });
                        await loadServerProperties();
                    } else {
                        property.paused = !property.paused;
                        saveSellerProperties();
                    }
                    showSellerPage();
                } catch (error) { showMessage(error.message); }
                finally { button.disabled = false; }
            }
        }
    }
});

getElement("bankList").addEventListener("change", function (event) {
    if (event.target.name === "bank") {
        selectedBankId = event.target.value;
        showBanks();
    }
});

// إظهار الحقول الإضافية عند اختيار حساب البائع.
function updateSellerFields() {
    const role = document.querySelector('input[name="role"]:checked').value;
    const isSeller = role === "seller";
    getElement("sellerFields").hidden = !isSeller;
    getElement("sellerFields").disabled = !isSeller;
    const sellerType = getElement("sellerTypeInput").value;
    const isOffice = isSeller && sellerType === "office";
    const needsLicense = isSeller && (sellerType === "office" || sellerType === "broker");
    getElement("businessNameLabel").hidden = !isOffice;
    getElement("businessNameInput").disabled = !isOffice;
    getElement("businessNameInput").required = isOffice;
    getElement("licenseLabel").hidden = !needsLicense;
    getElement("licenseInput").disabled = !needsLicense;
    getElement("licenseInput").required = needsLicense;
    getElement("profileError").hidden = true;
}

function openProfileForm(role) {
    setRegistrationMode(Boolean(currentUser));
    getElement("loginForm").reset();
    if (currentUser) {
        getElement("nameInput").value = currentUser.name || "";
        getElement("emailInput").value = currentUser.email || "";
        getElement("phoneInput").value = currentUser.phone || "";
        getElement("userCityInput").value = currentUser.city || "";
        getElement("sellerTypeInput").value = currentUser.sellerType || "";
        getElement("contactMethodInput").value = currentUser.contactMethod || "";
        getElement("sellerDistrictInput").value = currentUser.district || "";
        getElement("businessNameInput").value = currentUser.businessName || "";
        getElement("licenseInput").value = currentUser.license || "";
        getElement("sellerBioInput").value = currentUser.bio || "";
    }
    document.querySelector('input[name="role"][value="' + role + '"]').checked = true;
    updateSellerFields();
    document.querySelector(".role-options").hidden = Boolean(currentUser);
    getElement("registrationTitle").nextElementSibling.textContent = currentUser ? "أكمل بيانات البائع لتتمكن من عرض عقاراتك وإدارة إعلاناتك." : "اختر طريقة استخدامك لعقاري.";
    getElement("registerInfo").hidden = Boolean(currentUser);
    if (currentUser) {
        getElement("registrationTitle").textContent = currentUser.role === "seller" ? "بيانات البائع" : "ابدأ البيع مع عقاري";
        getElement("registrationSubmit").textContent = currentUser.role === "seller" ? "حفظ بيانات البائع" : "تفعيل خدمات البائع";
    }
    getElement("loginDialog").showModal();
}

function showProfileSummary() {
    if (!currentUser) return;
    const rows = [
        ["الاسم الكامل", currentUser.name],
        ["البريد الإلكتروني", currentUser.email],
        ["رقم الجوال", currentUser.phone],
        ["المدينة", currentUser.city]
    ];
    if (currentUser.role === "seller") {
        const types = { owner: "مالك العقار", broker: "وسيط عقاري", office: "مكتب / شركة عقارية" };
        const methods = { phone: "اتصال هاتفي", whatsapp: "واتساب", email: "بريد إلكتروني" };
        rows.push(["صفة البائع", types[currentUser.sellerType]]);
        rows.push(["التواصل المفضل", methods[currentUser.contactMethod]]);
        rows.push(["نطاق العمل", currentUser.district]);
        if (currentUser.sellerType === "office") rows.push(["اسم المكتب", currentUser.businessName]);
        if (currentUser.sellerType === "office" || currentUser.sellerType === "broker") {
            rows.push(["ترخيص فال (غير متحقق)", currentUser.license]);
        }
        rows.push(["نبذة", currentUser.bio]);
    }
    let content = "";
    for (let i = 0; i < rows.length; i++) {
        if (rows[i][1]) content += "<div><span>" + rows[i][0] + "</span><strong>" + safeText(rows[i][1]) + "</strong></div>";
    }
    getElement("profileSummary").innerHTML = content;
    getElement("emailStatus").textContent = currentUser.emailVerified ? "البريد الإلكتروني مؤكد" : "البريد الإلكتروني غير مؤكد";
    getElement("resendEmailButton").hidden = currentUser.emailVerified;
    const needsFal = currentUser.role === "seller" && (currentUser.sellerType === "broker" || currentUser.sellerType === "office");
    getElement("accountLicenseStatus").hidden = !needsFal;
    getElement("accountLicenseStatus").textContent = needsFal ? "ترخيص فال: بانتظار التحقق الرسمي — الربط الآلي غير مفعّل." : "";
}

const roleInputs = document.querySelectorAll('input[name="role"]');
for (let i = 0; i < roleInputs.length; i++) {
    roleInputs[i].addEventListener("change", updateSellerFields);
}
getElement("sellerTypeInput").addEventListener("change", updateSellerFields);
// وصول مباشر للوحة البائع بدون فتح نموذج تعديل الحساب.
function goToMyListings() {
    if (!currentUser || currentUser.role !== "seller") return;
    getElement("accountDialog").hidden = true;
    showSellerPage();
    getElement("sellerPage").scrollIntoView({ behavior: "smooth", block: "start" });
}

getElement("myListingsNav").addEventListener("click", goToMyListings);

getElement("editProfileButton").addEventListener("click", function () {
    getElement("profileName").value = currentUser.name;
    getElement("profileEmail").value = currentUser.email;
    getElement("profilePhone").value = currentUser.phone;
    getElement("profileCity").value = currentUser.city;
    setPersonalEditing(true);
    getElement("profileName").focus();
});
function setPersonalEditing(editing) {
    getElement("personalInfoForm").hidden = !editing;
    getElement("profileSummary").hidden = editing;
    getElement("editProfileButton").hidden = editing;
    getElement("personalInfoError").hidden = true;
}
getElement("cancelPersonalEdit").addEventListener("click", function () { setPersonalEditing(false); });
getElement("backFromAccount").addEventListener("click", showBuyerPage);
getElement("editSellerInfoButton").addEventListener("click", function () { openProfileForm("seller"); });
getElement("personalInfoForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"]');
    button.disabled = true;
    try {
        const result = await apiRequest("/api/profile", "PUT", {
            ...currentUser,
            name: getElement("profileName").value.trim(),
            phone: getElement("profilePhone").value.trim(),
            city: getElement("profileCity").value
        });
        currentUser = result.user;
        getElement("accountName").textContent = currentUser.name;
        getElement("accountButton").textContent = "حسابي · " + currentUser.name;
        showProfileSummary();
        setPersonalEditing(false);
        showMessage("تم حفظ بياناتك.");
    } catch (error) {
        getElement("personalInfoError").textContent = error.message;
        getElement("personalInfoError").hidden = false;
    } finally { button.disabled = false; }
});
function showExtraPropertyDetails(property) {
    let information = [];
    if (property.street) information.push("الشارع: " + property.street);
    if (property.age !== undefined) information.push("عمر العقار: " + property.age + " سنة");
    if (property.direction) information.push("الواجهة: " + property.direction);
    if (property.floor) information.push("الدور: " + property.floor);
    if (property.furnished) information.push("التأثيث: " + property.furnished);
    if (property.streetWidth) information.push("عرض الشارع: " + property.streetWidth + " م");
    if (property.permit) information.push("رقم ترخيص الإعلان (غير متحقق): " + property.permit);
    const featureNames = { adParking: "موقف سيارة", adElevator: "مصعد", adAC: "مكيفات", adKitchen: "مطبخ راكب", adGarden: "حديقة / حوش", adBalcony: "شرفة" };
    if (property.features) {
        for (let i = 0; i < property.features.length; i++) information.push(featureNames[property.features[i]]);
    }
    getElement("detailsExtra").textContent = information.join(" · ");
    getElement("detailsExtra").hidden = information.length === 0;
}

// بدء تشغيل الموقع.
if (databaseBackend) getElement("listingStorageNote").textContent = "إعلانات المالك النشطة تظهر لجميع الزوار. إعلانات الوسطاء والمكاتب تبقى مسودات حتى ربط التحقق الرسمي من فال.";
updateSellerFields();
updateUserPage();
loadSession();


}
