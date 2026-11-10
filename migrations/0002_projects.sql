-- Verkaufsprojekte (z. B. "Nikolaus-Aktion"): Artikel und Schichten gehören zu genau einem Projekt.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

ALTER TABLE articles ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE shifts ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX idx_articles_project ON articles (project_id);
CREATE INDEX idx_shifts_project ON shifts (project_id);

-- Vorhandene Daten (falls vorhanden) wandern in ein Start-Projekt
INSERT INTO projects (id, name)
SELECT 'start-projekt', 'Nikolausaktion'
WHERE EXISTS (SELECT 1 FROM articles) OR EXISTS (SELECT 1 FROM shifts);

UPDATE articles SET project_id = 'start-projekt' WHERE project_id IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = 'start-projekt');
UPDATE shifts SET project_id = 'start-projekt' WHERE project_id IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = 'start-projekt');
