-- أتمتة: إيصال بالبريد بعد كل دفعة + تقرير شهري
alter table public.automations drop constraint if exists automations_kind_check;
alter table public.automations add constraint automations_kind_check
  check (kind in ('welcome','renew','followup','stage','dues','report','mreport','receipt'));

insert into public.automations (name, kind, enabled, ch, days, subject, msg)
select 'إيصال بالبريد بعد الدفع', 'receipt', false, 'mail', 0, 'إيصال دفع من Biosyn Egypt',
  E'أهلاً {الاسم}،\nنشكر لك ثقتك. هذا إيصال دفعتك:\nالبند: {البند}\nالمبلغ: {المبلغ} جنيه\nالتاريخ: {التاريخ}\nرقم الإيصال: {الرقم}\n\nBiosyn Egypt · www.biosynegypt.com'
where not exists (select 1 from public.automations where kind = 'receipt');

-- days في التقرير الشهري = يوم الإرسال من الشهر (1-28)
insert into public.automations (name, kind, enabled, ch, days, subject, msg)
select 'التقرير الشهري بالبريد', 'mreport', false, 'mail', 1, 'التقرير الشهري — Biosyn CRM', null
where not exists (select 1 from public.automations where kind = 'mreport');
