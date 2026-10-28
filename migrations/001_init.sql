CREATE TABLE categories(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES categories(id), sort INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1);
CREATE TABLE products(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, sku TEXT UNIQUE,
  description TEXT NOT NULL DEFAULT '', category_id INTEGER REFERENCES categories(id),
  composition TEXT NOT NULL DEFAULT '', width_cm INTEGER, density TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX idx_products_cat ON products(category_id, published, archived);
CREATE INDEX idx_products_name ON products(name);
CREATE TABLE variants(
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label TEXT NOT NULL, price_kop INTEGER NOT NULL CHECK(price_kop>=0), stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0),
  unit TEXT NOT NULL DEFAULT 'м', active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_variants_product ON variants(product_id);
CREATE TABLE images(id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, file TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE orders(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE, idem_key TEXT UNIQUE, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL, delivery TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '',
  total_kop INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK(status IN('new','confirmed','processing','shipped','done','cancelled')),
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE TABLE order_items(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, variant_id INTEGER,
  product_name TEXT NOT NULL, variant_label TEXT NOT NULL, unit TEXT NOT NULL, unit_price_kop INTEGER NOT NULL, qty INTEGER NOT NULL);
CREATE TABLE order_history(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, status TEXT NOT NULL, admin_id INTEGER, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE admins(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('super','manager','editor')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE sessions(token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE pages(slug TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', published INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE audit_log(id INTEGER PRIMARY KEY, admin_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO settings(key,value) VALUES
 ('company','Коломийські тканини'),
 ('hero_title','Тканини для вишивання та творчості — від українського виробника'),
 ('hero_subtitle','Домоткані полотна різних кольорів, щільності та складу для ваших виробів і творчих ідей.'),
 ('topbar',''),('phone',''),('email',''),('address',''),('hours',''),('social',''),('advantages',''),('seo_description','');
INSERT INTO pages(slug,title,body,published) VALUES
 ('about','Про виробництво','',0),('wholesale','Оптовим покупцям','',0),('delivery','Доставка й оплата','',0),
 ('privacy','Політика конфіденційності','',0),('returns','Повернення та обмін','',0);
