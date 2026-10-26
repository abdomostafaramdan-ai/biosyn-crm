-- قواعد أتمتة جديدة: تذكير المستحقات المعلّقة + تقرير أسبوعي بالبريد
alter table public.automations drop constraint if exists automations_kind_check;
alter table public.automations add constraint automations_kind_check
  check (kind in ('welcome','renew','followup','stage','dues','report'));

insert into public.automations (name, kind, enabled, ch, days, subject, msg)
select 'تذكير بالمستحقات المعلّقة', 'dues', false, 'auto', 3, 'تذكير بمبلغ مستحق',
  E'أهلاً {الاسم}،\nنذكّركم بوجود مبلغ مستحق بقيمة {المبلغ} جنيه. نرجو إتمام السداد، وإن كنتم قد سدّدتموه فنشكر لكم ذلك.'
where not exists (select 1 from public.automations where kind = 'dues');

-- days في قاعدة التقرير = يوم الإرسال (0 أحد … 6 سبت)
insert into public.automations (name, kind, enabled, ch, days, subject, msg)
select 'التقرير الأسبوعي بالبريد', 'report', false, 'mail', 6, 'التقرير الأسبوعي — Biosyn CRM', null
where not exists (select 1 from public.automations where kind = 'report');
