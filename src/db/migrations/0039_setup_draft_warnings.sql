alter table setup_draft
  add column if not exists warnings text not null default '[]';