# عقاري — Node.js + MAMP MySQL

نفس طريقة ربط مشروع Code & Coffee: الواجهة ترسل الطلبات لخادم Node.js، والخادم يستخدم `mysql2/promise` و`createPool` لحفظ البيانات وقراءتها من MySQL الذي يشغّله MAMP.

## التشغيل

1. شغّل MySQL من MAMP. المنفذ الافتراضي 3306.
2. افتح الطرفية داخل مجلد المشروع، ثم نفّذ:

```powershell
npm install
npm run db:setup
npm start
```

افتح http://localhost:3000 واترك الطرفية وMySQL شغالين. لا تحتاج إلى نسخ المشروع داخل htdocs لتشغيل نسخة Node.

إذا كان المنفذ مشغولًا، استخدم:

```powershell
$env:PORT=3002
npm start
```

ثم افتح http://localhost:3002 . هذا هو منفذ المعاينة الذي جُهّز أثناء العمل.

## اتصال قاعدة البيانات

في `db.js` يوجد الاتصال مثل مثال القهوة:

```javascript
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'root',
    port: 3306,
    database: 'aqari',
    waitForConnections: true,
    connectionLimit: 10
});
```

إعداد root الافتراضي مخصص لـMAMP المحلي فقط. يمكن تغيير الإعدادات عبر `AQARI_DB_HOST`, `AQARI_DB_PORT`, `AQARI_DB_USER`, `AQARI_DB_PASSWORD`, `AQARI_DB_DATABASE`. استخدم مستخدمًا مخصصًا وHTTPS عند النشر.

`npm run db:setup` ينشئ قاعدة `aqari` والجداول إن لم تكن موجودة ولا يحذف بيانات سابقة. لا يستخدم أو يعدّل قاعدة مشروع القهوة.

## مشاهدة البيانات

افتح phpMyAdmin من صفحة MAMP، ثم اختر قاعدة `aqari`:

- `aqari_users`: الحسابات وبياناتها، وكلمات مرور محمية بالتجزئة.
- `aqari_properties`: العقارات المحفوظة وحالتها ومعرّف مالكها.

الحسابات والإعلانات التي حُفظت في قاعدة MySQL من نسخة PHP تبقى متاحة في نسخة Node. حسابات Node القديمة التي كانت في private-data لم تُنقل تلقائيًا.

## السلوك والحدود

- الحسابات والإعلانات محفوظة في MySQL. المفضلة محفوظة في المتصفح.
- إعلانات المالك النشطة تُعرض للزوار. إعلانات الوسيط والمكتب تبقى مسودات حتى ربط التحقق الرسمي من فال.
- جلسات Node في ذاكرة الخادم، وإعادة تشغيله تتطلب تسجيل الدخول مجددًا.
- تأكيد البريد واستعادة كلمة المرور يحتاجان إعداد `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL`. لا ترفع مفاتيح البريد إلى GitHub.
- الأسعار والعقارات النموذجية وتقديرات التمويل توضيحية وغير ملزمة.
- نسخة GitHub Pages واجهة عرض فقط. Node وMySQL يعملان محليًا؛ الوصول العام يحتاج استضافة تشغّلهما.
- ملفات PHP متروكة للتوافق مع نسخة MAMP السابقة على http://localhost/aqari/ . النسخة الأساسية الآن هي Node مع MySQL.

## النشر العام من GitHub على Railway

المستودع يحتوي Dockerfile وrailway.json لتشغيل Node وفحص اتصال MySQL عند النشر. لا تحتاج نسخة الاستضافة إلى MAMP أو بقاء الكمبيوتر مفتوحًا.

1. أنشئ مشروع Railway من مستودع `rmaasbadr/aqari-web` وأضف خدمة MySQL في نفس المشروع.
2. أضف متغيرات مرجعية إلى خدمة الموقع (اسم خدمة قاعدة البيانات في هذا المثال `MySQL`):

```text
MYSQLHOST=${{MySQL.MYSQLHOST}}
MYSQLPORT=${{MySQL.MYSQLPORT}}
MYSQLUSER=${{MySQL.MYSQLUSER}}
MYSQLPASSWORD=${{MySQL.MYSQLPASSWORD}}
MYSQLDATABASE=${{MySQL.MYSQLDATABASE}}
```

3. أنشئ Public Domain لخدمة الموقع. يُستخدم RAILWAY_PUBLIC_DOMAIN للتحقق من أصل الطلبات، ويمكن تعيين APP_URL لرابط HTTPS النهائي إذا استخدمت نطاقًا مخصصًا.
4. انتظر نجاح النشر وفحص `/api/health`، ثم اختبر حسابًا جديدًا. لم تُرفع بيانات MySQL المحلية إلى الاستضافة.

يتطلب النشر حساب Railway متصلًا. أي خطة مدفوعة أو دفع يحتاج موافقة صاحبة المشروع. الجلسات الحالية في ذاكرة الخادم: إعادة النشر تتطلب تسجيل الدخول مجددًا، والتشغيل مضبوط لخادم واحد.

## الاختبارات

```powershell
npm run check
$env:AQARI_TEST_URL='http://127.0.0.1:3002/'
$env:AQARI_TEST_BACKEND='node'
npm run test:mysql
```

تغطي التسجيل، الدخول والخروج، تعديل البيانات، منع الطلبات من أصل آخر، صلاحيات البائع وملكية العقارات، والحفظ والقراءة من قاعدة البيانات. تُنشأ حسابات اختبار مؤقتة وتُزال بعد الفحص.
