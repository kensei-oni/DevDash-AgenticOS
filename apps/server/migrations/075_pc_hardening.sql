-- Computer Use security hardening: per-device allowed folders + member-wide server pause kill-switch.
alter table pc_devices add column allowed_folders text not null default '[]';

create table pc_member_settings (
  user_id integer primary key references users(id) on delete cascade,
  paused integer not null default 0,
  updated_at integer not null default (unixepoch())
);

create index if not exists idx_pc_audit_user_created on pc_audit_log(user_id, created_at);
