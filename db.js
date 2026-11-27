// Same architecture as Code & Coffee: Node.js -> createPool -> MAMP MySQL.
const mysql = require('mysql2/promise');
const settings = {
    host: process.env.AQARI_DB_HOST || process.env.MYSQLHOST || 'localhost',
    user: process.env.AQARI_DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.AQARI_DB_PASSWORD || process.env.MYSQLPASSWORD || 'root',
    port: Number(process.env.AQARI_DB_PORT || process.env.MYSQLPORT || 3306),
    database: process.env.AQARI_DB_DATABASE || process.env.MYSQLDATABASE || 'aqari',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
};
const pool = mysql.createPool(settings);
async function setupDatabase() {
    if (!/^[a-zA-Z0-9_]+$/.test(settings.database)) throw new Error('Invalid database name');
    if (process.env.AQARI_DB_SKIP_CREATE !== 'true') {
        const bootstrap = await mysql.createConnection({host:settings.host,port:settings.port,user:settings.user,password:settings.password,charset:settings.charset});
        try { await bootstrap.query('CREATE DATABASE IF NOT EXISTS `' + settings.database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); }
        finally { await bootstrap.end(); }
    }
    await pool.execute('CREATE TABLE IF NOT EXISTS aqari_users (id VARCHAR(64) PRIMARY KEY, email VARCHAR(100) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, profile LONGTEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');
    await pool.execute('CREATE TABLE IF NOT EXISTS aqari_properties (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, owner_id VARCHAR(64) NOT NULL, data LONGTEXT NOT NULL, paused TINYINT NOT NULL DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX(owner_id), FOREIGN KEY(owner_id) REFERENCES aqari_users(id)) ENGINE=InnoDB');
}
async function readUsers() {
    const [rows] = await pool.execute('SELECT id,email,profile,password_hash FROM aqari_users');
    return rows.map(row => ({ ...JSON.parse(row.profile), id: row.id, email: row.email, passwordHash: row.password_hash }));
}
async function saveUser(user, insert = false) {
    const { passwordHash, salt, ...profile } = user;
    if (insert) {
        await pool.execute('INSERT INTO aqari_users(id,email,password_hash,profile) VALUES(?,?,?,?)', [user.id,user.email,passwordHash,JSON.stringify(profile)]);
    } else {
        await pool.execute('UPDATE aqari_users SET email=?,password_hash=?,profile=? WHERE id=?', [user.email,passwordHash,JSON.stringify(profile),user.id]);
    }
}
async function listProperties(user) {
    const [rows] = user
        ? await pool.execute('SELECT id,owner_id,data,paused FROM aqari_properties WHERE paused=0 OR owner_id=? ORDER BY id DESC LIMIT 500',[user.id])
        : await pool.execute('SELECT id,owner_id,data,paused FROM aqari_properties WHERE paused=0 ORDER BY id DESC LIMIT 500');
    return rows.map(row=>({...JSON.parse(row.data),id:Number(row.id)+1000000000,ownerId:row.owner_id,owner:true,paused:!!row.paused}));
}
function invalid(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
async function saveProperty(user, data) {
    if (user.role !== 'seller') invalid('إضافة العقارات متاحة للبائع فقط.',403);
    if (!data.property || typeof data.property !== 'object' || Array.isArray(data.property)) invalid('بيانات العقار غير صحيحة.');
    const p = {};
    for (const field of ['ar','name','cityAr','city','description','street','direction','floor','furnished','permit','img']) {
        const value=data.property[field];
        if (value !== undefined && (typeof value !== 'string' || value.length > 1000)) invalid('أحد حقول العقار غير صحيح.');
        if (value !== undefined) p[field]=value;
    }
    p.type=data.property.type; p.tab=data.property.tab;
    if (!p.ar || !['Villa','Apartment','Townhouse'].includes(p.type) || !['Buy','Rent'].includes(p.tab)) invalid('أكمل عنوان العقار ونوعه.');
    for (const [field,max] of Object.entries({price:1e9,area:1e6,beds:50,baths:50,age:150,streetWidth:200})) {
        const value=data.property[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value<0 || value>max) invalid('مواصفات العقار غير صحيحة.');
        p[field]=value;
    }
    if (!(p.price>0) || !(p.area>0)) invalid('السعر والمساحة مطلوبان.');
    const features=data.property.features || [];
    if (!Array.isArray(features) || features.length>6 || features.some(f=>!['adParking','adElevator','adAC','adKitchen','adGarden','adBalcony'].includes(f))) invalid('المميزات غير صحيحة.');
    p.features=features;
    if (data.property.photo) {
        if (typeof data.property.photo !== 'string') invalid('الصورة غير صحيحة.');
        const match=data.property.photo.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) invalid('الصورة غير صحيحة.');
        const bytes=Buffer.from(match[2],'base64');
        const valid=(match[1]==='jpeg' && bytes[0]===255 && bytes[1]===216 && bytes[2]===255)
            || (match[1]==='png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
            || (match[1]==='webp' && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP');
        if (!valid || bytes.length>2097152) invalid('الصورة غير صحيحة أو تتجاوز 2 ميجابايت.');
        p.photo=data.property.photo;
    }
    p.paused=!!data.property.paused || user.sellerType!=='owner';
    p.draft=user.sellerType!=='owner';
    let id=Number(data.id || 0)-1000000000;
    if (data.id && (!Number.isSafeInteger(id) || id<=0)) invalid('رقم العقار غير صحيح.');
    if (id>0) {
        const [rows]=await pool.execute('SELECT owner_id FROM aqari_properties WHERE id=?',[id]);
        if (!rows[0] || rows[0].owner_id !== user.id) invalid('العقار غير متاح للتعديل.',403);
        await pool.execute('UPDATE aqari_properties SET data=?,paused=? WHERE id=? AND owner_id=?',[JSON.stringify(p),Number(p.paused),id,user.id]);
    } else {
        const [result]=await pool.execute('INSERT INTO aqari_properties(owner_id,data,paused) VALUES(?,?,?)',[user.id,JSON.stringify(p),Number(p.paused)]);
        id=result.insertId;
    }
    return {...p,id:Number(id)+1000000000,ownerId:user.id,owner:true};
}
module.exports={pool,setupDatabase,readUsers,saveUser,listProperties,saveProperty};
if (require.main===module) setupDatabase().then(()=>console.log('Aqari MySQL schema ready.')).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
