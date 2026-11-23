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
//  - Spare pool: settings carries unclaimed spare_toggle_1..20 and
//    spare_text_1..10. A new toggle-shaped/text-shaped feature just claims
//    one AS-IS (keeps the spare_toggle_N name, documented in
//    app/lib/definitions.ts) — NO migration, NO rename. Only an occasional
//    batch cleanup (like 0009) renames claimed columns to proper names and
//    tops the pool back up to 20/10. Keep app/api/setup/route.ts in step
//    with any such cleanup.

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


// ---- 0009 helpers -------------------------------------------------------
// Idempotent rename of a settings column: renames oldName -> newName only if
// oldName exists and newName doesn't yet (so re-running, or running on a
// tenant created from the current setup, is a no-op).
function renameSettingsColumn(oldName, newName) {
  return `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = '${oldName}')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = '${newName}') THEN
      ALTER TABLE settings RENAME COLUMN ${oldName} TO ${newName};
    END IF;
  END $$`;
}

// Spare columns that got claimed by a real feature, and the name each one
// should have had all along. (inverted: true -> the flag means the opposite
// of the feature being on, so the column default false keeps old behavior.)
const CLAIMED_TOGGLES = [
  ['spare_toggle_6', 'show_status_5'],
  ['spare_toggle_7', 'hide_types'],
  ['spare_toggle_8', 'use_datetime'],
  ['spare_toggle_9', 'show_datetime'],
  ['spare_toggle_10', 'ungroup_identical_items'],
  ['spare_toggle_11', 'hide_locations'],
];
const CLAIMED_TEXTS = [['spare_text_4', 'last_login_at']];

const SPARE_TOGGLE_COUNT = 20;
const SPARE_TEXT_COUNT = 10;

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
  {
    id: '0009_rename_claimed_spares_and_retire_contact_info',
    description:
      'Give claimed spare columns their real names (spare_toggle_6 -> show_status_5, 7 -> hide_types, 8 -> use_datetime, 9 -> show_datetime, 10 -> ungroup_identical_items, 11 -> hide_locations, spare_text_4 -> last_login_at), drop the retired settings.contact_info, and top the spare pool back up to spare_toggle_1..20 and spare_text_1..10.',
    statements: [
      'ALTER TABLE settings DROP COLUMN IF EXISTS contact_info',
      // Renames first (keeps every tenant's existing values), then make sure
      // the named column exists even if neither old nor new did.
      ...CLAIMED_TOGGLES.flatMap(([oldName, newName]) => [
        renameSettingsColumn(oldName, newName),
        `ALTER TABLE settings ADD COLUMN IF NOT EXISTS ${newName} BOOLEAN NOT NULL DEFAULT false`,
      ]),
      ...CLAIMED_TEXTS.flatMap(([oldName, newName]) => [
        renameSettingsColumn(oldName, newName),
        `ALTER TABLE settings ADD COLUMN IF NOT EXISTS ${newName} VARCHAR(255)`,
      ]),
      // The pool: the renamed-away spare_toggle_6..11 / spare_text_4 are
      // re-created here as fresh unclaimed columns, plus the new ones.
      ...Array.from({ length: SPARE_TOGGLE_COUNT }, (_, i) =>
        `ALTER TABLE settings ADD COLUMN IF NOT EXISTS spare_toggle_${i + 1} BOOLEAN NOT NULL DEFAULT false`
      ),
      ...Array.from({ length: SPARE_TEXT_COUNT }, (_, i) =>
        `ALTER TABLE settings ADD COLUMN IF NOT EXISTS spare_text_${i + 1} VARCHAR(255)`
      ),
    ],
  },
  {
    id: '0010_search_by_barcode',
    description:
      'Dashboard item search also finds an item by exact barcode: search_items_by_name gains an include_barcode parameter (the storefront never sets it). The old two-argument version is dropped so the call is not ambiguous.',
    statements: [
      'DROP FUNCTION IF EXISTS search_items_by_name(text, integer)',
      // Same definition as app/api/setup/route.ts (fresh tenants) — keep in sync.
      `CREATE OR REPLACE FUNCTION search_items_by_name(search_term text, match_limit integer DEFAULT 300, include_barcode boolean DEFAULT false)
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
            UNION ALL
            -- Exact (case-insensitive) barcode match, always ranked first.
            -- Only when the caller asks for it (the dashboard — never the
            -- public storefront) and the tenant actually uses barcodes.
            SELECT i.id, 1.0::real
              FROM items i
              WHERE include_barcode
                AND i.barcode IS NOT NULL
                AND lower(i.barcode) = lower(btrim(search_term))
                AND COALESCE((SELECT use_barcode FROM settings ORDER BY id LIMIT 1), false)
          ) s
          GROUP BY s.id
          ORDER BY rank DESC
          LIMIT match_limit;
        $$ LANGUAGE sql STABLE`,
    ],
  },
];

module.exports = { migrations };
