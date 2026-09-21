-- Generated once by scripts/order-catalogue.mjs. Do not hand-edit.
--
-- Where the storefront's product order lives.
--
-- Until now it lived in the index of the array in src/data/products.ts, and
-- nowhere else. 0008 inserted all 45 rows in one batch, so every row carries
-- the same created_at and `ORDER BY created_at DESC, id` is alphabetical by
-- id in practice. Generating products.ts from that query would have shuffled
-- the shop page into alphabetical order, interleaving phones with laptops,
-- and no test would have gone red.
--
-- DEFAULT 0 rather than NULL: a product added later sorts to the front,
-- which is where a new drop belongs, and it means no read has to cope with a
-- missing value.

ALTER TABLE products ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

UPDATE products SET display_order = 0 WHERE id = 'iphone-18-pro';
UPDATE products SET display_order = 1 WHERE id = 'iphone-18-pro-max';
UPDATE products SET display_order = 2 WHERE id = 'galaxy-s26-ultra';
UPDATE products SET display_order = 3 WHERE id = 'pixel-11-pro';
UPDATE products SET display_order = 4 WHERE id = 'oneplus-15';
UPDATE products SET display_order = 5 WHERE id = 'xiaomi-17-ultra';
UPDATE products SET display_order = 6 WHERE id = 'xps-16';
UPDATE products SET display_order = 7 WHERE id = 'thinkpad-x1-carbon';
UPDATE products SET display_order = 8 WHERE id = 'zenbook-s14';
UPDATE products SET display_order = 9 WHERE id = 'zenbook-duo';
UPDATE products SET display_order = 10 WHERE id = 'airpods-max';
UPDATE products SET display_order = 11 WHERE id = 'macbook-pro';
UPDATE products SET display_order = 12 WHERE id = 'watch-ultra';
UPDATE products SET display_order = 13 WHERE id = 'galaxy-s26';
UPDATE products SET display_order = 14 WHERE id = 'galaxy-buds';
UPDATE products SET display_order = 15 WHERE id = 'odyssey-oled';
UPDATE products SET display_order = 16 WHERE id = 'wh1000xm6';
UPDATE products SET display_order = 17 WHERE id = 'alpha-7cr';
UPDATE products SET display_order = 18 WHERE id = 'fx3-cinema';
UPDATE products SET display_order = 19 WHERE id = 'qc-ultra';
UPDATE products SET display_order = 20 WHERE id = 'open-earbuds';
UPDATE products SET display_order = 21 WHERE id = 'soundlink-max';
UPDATE products SET display_order = 22 WHERE id = 'hd900s';
UPDATE products SET display_order = 23 WHERE id = 'momentum-4';
UPDATE products SET display_order = 24 WHERE id = 'mavic-4-pro';
UPDATE products SET display_order = 25 WHERE id = 'osmo-pocket';
UPDATE products SET display_order = 26 WHERE id = 'rs4-gimbal';
UPDATE products SET display_order = 27 WHERE id = 'mx-master';
UPDATE products SET display_order = 28 WHERE id = 'mx-mechanical';
UPDATE products SET display_order = 29 WHERE id = 'brio-webcam';
UPDATE products SET display_order = 30 WHERE id = 'blackwidow';
UPDATE products SET display_order = 31 WHERE id = 'viper-v3';
UPDATE products SET display_order = 32 WHERE id = 'blade-16';
UPDATE products SET display_order = 33 WHERE id = 'prime-powerbank';
UPDATE products SET display_order = 34 WHERE id = 'soundcore-liberty';
UPDATE products SET display_order = 35 WHERE id = 'gan-charger';
UPDATE products SET display_order = 36 WHERE id = 'phone-3a';
UPDATE products SET display_order = 37 WHERE id = 'ear-open';
UPDATE products SET display_order = 38 WHERE id = 'cmf-buds';
UPDATE products SET display_order = 39 WHERE id = 'q3-max';
UPDATE products SET display_order = 40 WHERE id = 'switch-set';
UPDATE products SET display_order = 41 WHERE id = 'k-pro-mouse';
UPDATE products SET display_order = 42 WHERE id = 'op1-field';
UPDATE products SET display_order = 43 WHERE id = 'tp7-recorder';
UPDATE products SET display_order = 44 WHERE id = 'ob4-speaker';
