-- أتمتة: تذكير قبل موعد القسط
alter table public.automations drop constraint if exists automations_kind_check;
alter table public.automations add constraint automations_kind_check
  check (kind in ('welcome','renew','followup','stage','dues','report','mreport','receipt','instrem'));
insert into public.automations (name, kind, enabled, ch, days, subject, msg)
select 'تذكير بموعد القسط', 'instrem', false, 'auto', 2, 'موعد قسطك القادم',
  E'أهلاً {الاسم}،\nنذكّرك بموعد القسط القادم ({البند}) بقيمة {المبلغ} جنيه بتاريخ {التاريخ}. شكراً لثقتك في Biosyn Egypt.'
where not exists (select 1 from public.automations where kind = 'instrem');
