// The ordered list of schema migrations applied to every tenant's database
// by api/migrate.js. This is now THE way to change the schema of
// already-provisioned tenants — it replaces running scripts/*.sql by hand.
//
// RULES
//  - Append only. Never edit or reorder a migration once it has shipped;
//    add a new one instead. `id` is what's recorded in each tenant's
//    schema_migrations table, so it must stay stable.
//  - Every statement must be IDEMPOTENT (IF NOT EXISTS / IF EXISTS / safe to
//    repeat). Tenants provisioned recently already have most of the
//    baseline, and an interrupted run may re-run a migration.
//  - Each migration runs in a single transaction together with its
//    schema_migrations insert: it's applied completely or not at all.
//  - Keep app/api/setup/route.ts (fresh tenants) in step with these: a brand
//    new tenant gets the final schema from setup, then every migration here
//    runs against it as a no-op and gets recorded.
//  - Claiming an existing spare_toggle_N / spare_text_N needs NO migration —
//    that's the whole point of the pool. Only a *new* column needs one.

const SETTINGS_BOOLEAN_COLUMNS = [
  'show_featured_items',
  'show_description',
  'checklist_added_contact',
  'checklist_organized',
  'checklist_picked_theme',
  'show_dashboard_storage_widget',
  'checklist_renamed_taxonomy',
  'checklist_added_item',
  'checklist_named_storefront',
  'checklist_went_live',
  'spare_toggle_6',
  'spare_toggle_7',
  'spare_toggle_8',
];

const SETTINGS_TEXT_COLUMNS = [
  'contact_telegram',
  'contact_email',
  'contact_instagram',
  'spare_text_4',
  'spare_text_5',
  'spare_text_6',
  'spare_text_7',
  'spare_text_8',
  'spare_text_9',
  'spare_text_10',
];

const RLS_TABLES = [
  'currencies',
  'languages',
  'types',
  'categories',
  'images',
  'sales',
  'users',
  'share_passwords',
  'packages',
  'items',
  'blueprints',
  'settings',
  'sales_items',
  'item_images',
];

const migrations = [
  {
    id: '0001_settings_baseline_columns',
    description:
      'Bring the settings table up to the current column set (what scripts/add-spare-toggles.sql + add-checklist-columns.sql did by hand). No backfill of checklist flags.',
    statements: [
      ...SETTINGS_BOOLEAN_COLUMNS.map(
        (c) => `ALTER TABLE settings ADD COLUMN IF NOT EXISTS ${c} BOOLEAN NOT NULL DEFAULT false`
      ),
      ...SETTINGS_TEXT_COLUMNS.map(
        (c) => `ALTER TABLE settings ADD COLUMN IF NOT EXISTS ${c} VARCHAR(255)`
      ),
    ],
  },
  {
    id: '0002_description_text',
    description: 'Widen description columns from VARCHAR(255) to TEXT.',
    statements: [
      'ALTER TABLE IF EXISTS packages ALTER COLUMN description TYPE TEXT',
      'ALTER TABLE IF EXISTS items ALTER COLUMN description TYPE TEXT',
      'ALTER TABLE IF EXISTS blueprints ALTER COLUMN description TYPE TEXT',
    ],
  },
  {
    id: '0003_documents_package_nullable',
    description: 'documents.package_id may be null (documents not attached to a package).',
    statements: ['ALTER TABLE IF EXISTS documents ALTER COLUMN package_id DROP NOT NULL'],
  },
  {
    id: '0004_enable_rls',
    description: 'Row level security on every table (what scripts/enable-rls.sql did).',
    statements: RLS_TABLES.map((t) => `ALTER TABLE IF EXISTS ${t} ENABLE ROW LEVEL SECURITY`),
  },
  {
    id: '0005_search_description_and_tags',
    description:
      'Item search (search_items_by_name) also matches description and category/type/location names, not just the item name.',
    statements: [
      'CREATE EXTENSION IF NOT EXISTS pg_trgm',
      'CREATE INDEX IF NOT EXISTS items_description_trgm_idx ON items USING gin (description gin_trgm_ops)',
      // Same definition as app/api/setup/route.ts (fresh tenants) — keep in sync.
      `CREATE OR REPLACE FUNCTION search_items_by_name(search_term text, match_limit integer DEFAULT 300)
        RETURNS TABLE(id integer, rank real) AS $$
          SELECT s.id, max(s.score)::real AS rank
          FROM (
            SELECT i.id, word_similarity(search_term, i.name) AS score
              FROM items i WHERE search_term <% i.name
            UNION ALL
            SELECT i.id, word_similarity(search_term, i.description) * 0.9
              FROM items i WHERE search_term <% i.description
            UNION ALL
            SELECT ic.item_id, word_similarity(search_term, c.name) * 0.95
              FROM item_categories ic JOIN categories c ON c.id = ic.category_id
              WHERE search_term <% c.name
            UNION ALL
            SELECT it.item_id, word_similarity(search_term, t.name) * 0.95
              FROM item_types it JOIN types t ON t.id = it.type_id
              WHERE search_term <% t.name
            UNION ALL
            SELECT i.id, word_similarity(search_term, l.name) * 0.95
              FROM items i JOIN locations l ON l.id = i.location_id
              WHERE search_term <% l.name
          ) s
          GROUP BY s.id
          ORDER BY rank DESC
          LIMIT match_limit;
        $$ LANGUAGE sql STABLE`,
    ],
  },
  {
    id: '0006_blueprint_images',
    description: 'Blueprint galleries: blueprint_images join table (same shape as item_images).',
    statements: [
      `CREATE TABLE IF NOT EXISTS blueprint_images (
        blueprint_id INTEGER NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        PRIMARY KEY (blueprint_id, image_id)
      )`,
      'ALTER TABLE blueprint_images ENABLE ROW LEVEL SECURITY',
    ],
  },
  {
    id: '0007_item_datetime',
    description:
      'Optional per-item date/time (items.item_datetime, wall-clock, no time zone) and four more spare toggles (spare_toggle_9-12) to replenish the pool: 8 = use_datetime, 9 = show_datetime.',
    statements: [
      // TIMESTAMP WITHOUT TIME ZONE on purpose: it's the date/time as typed
      // ("the moment on this vacation"), shown identically to everyone, not
      // an instant that should shift with the viewer's time zone.
      'ALTER TABLE items ADD COLUMN IF NOT EXISTS item_datetime TIMESTAMP',
      'ALTER TABLE settings ADD COLUMN IF NOT EXISTS spare_toggle_9 BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE settings ADD COLUMN IF NOT EXISTS spare_toggle_10 BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE settings ADD COLUMN IF NOT EXISTS spare_toggle_11 BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE settings ADD COLUMN IF NOT EXISTS spare_toggle_12 BOOLEAN NOT NULL DEFAULT false',
    ],
  },
  {
    id: '0008_item_datetime_date_only',
    description:
      'items.item_datetime is date-only: convert the TIMESTAMP created by 0007 to DATE (any time part is dropped). No-op where it is already DATE.',
    statements: [
      'ALTER TABLE items ALTER COLUMN item_datetime TYPE DATE USING item_datetime::date',
    ],
  },
];

module.exports = { migrations };
