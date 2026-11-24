-- Allow multiple paired Tailscale devices per member (e.g. Windows PC + Android phone) with platform support.
-- Preserve pc_audit_log.device_id across table rebuild even with PRAGMA foreign_keys = ON inside a transaction.
create temp table _pc_audit_device_ids as
  select id, device_id from pc_audit_log where device_id is not null;

create table pc_devices_new (
  id integer primary key autoincrement,
  user_id integer not null references users(id) on delete cascade,
  name text not null,
  platform text not null default 'windows' check (platform in ('windows', 'android')),
  tailscale_ip text not null,
  port integer not null default 47821,
  token_sealed text not null,
  enabled integer not null default 1,
  allow_shell integer not null default 0,
  is_default integer not null default 0,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch()),
  last_seen_at integer,
  unique(user_id, tailscale_ip)
);

insert into pc_devices_new (id, user_id, name, platform, tailscale_ip, port, token_sealed, enabled, allow_shell, is_default, created_at, updated_at, last_seen_at)
select id, user_id, name, 'windows', tailscale_ip, port, token_sealed, enabled, allow_shell, 1, created_at, updated_at, last_seen_at
from pc_devices;

drop table pc_devices;
alter table pc_devices_new rename to pc_devices;

update pc_audit_log
set device_id = (select device_id from _pc_audit_device_ids where _pc_audit_device_ids.id = pc_audit_log.id)
where id in (select id from _pc_audit_device_ids);

drop table _pc_audit_device_ids;

create index idx_pc_devices_user on pc_devices(user_id, is_default desc, id asc);
