'use strict';
// ТІЛЬКИ для розробки. Створює позначені «ДЕМО» тестові товари з умовними цінами — це НЕ реальний асортимент.
// Видалити: npm run unseed:demo
if (process.env.NODE_ENV === 'production') { console.error('Відмова: demo-дані не можна створювати в production.'); process.exit(1); }
const { db } = require('../db');
if (process.argv.includes('--remove')) { db.exec('DELETE FROM products WHERE demo=1'); console.log('Демо-товари видалено (категорії залишено).'); process.exit(0); }
let cat = db.prepare("SELECT id FROM categories WHERE slug='demo-kategoriia'").get();
if (!cat) cat = { id: Number(db.prepare("INSERT INTO categories(slug,name,description) VALUES('demo-kategoriia','ДЕМО-категорія','Тестова категорія')").run().lastInsertRowid) };
[['ДЕМО: полотно A', 'demo-a', 'Тестовий склад', [['білий', 10000, 20], ['сірий', 11000, 0]]], ['ДЕМО: полотно B', 'demo-b', 'Тестовий склад', [['натуральний', 15050, 5]]]].forEach(([name, slug, comp, vs]) => {
  if (db.prepare('SELECT 1 FROM products WHERE slug=?').get(slug)) return;
  const id = Number(db.prepare('INSERT INTO products(slug,name,category_id,composition,width_cm,density,published,featured,demo,description) VALUES(?,?,?,?,?,?,1,1,1,?)').run(slug, name, cat.id, comp, 150, 'тест', 'Демонстраційний запис. Ціни й характеристики умовні.').lastInsertRowid);
  vs.forEach(([l, p, s], i) => db.prepare('INSERT INTO variants(product_id,label,price_kop,stock,sort) VALUES(?,?,?,?,?)').run(id, l, p, s, i));
});
console.log('Демо-дані створено.');
