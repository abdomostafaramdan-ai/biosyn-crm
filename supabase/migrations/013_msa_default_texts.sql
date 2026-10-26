-- نصوص الأتمتة الافتراضية بالعربية الفصحى (مُطبَّقة على قاعدة البيانات الحية)
update automations set msg=E'أهلاً {الاسم} 🌿\nشكراً لاشتراكك معنا. إن احتجت إلى أي مساعدة فراسلنا هنا.', subject='أهلاً بك في Biosyn Egypt' where kind='welcome' and msg like 'أهلاً {الاسم} 🌿%';
update automations set msg=E'أهلاً {الاسم}،\nسينتهي اشتراكك قريباً. جدّد الآن لتواصل دون انقطاع.', subject='اقترب انتهاء اشتراكك' where kind='renew' and msg like 'أهلاً {الاسم}،%';
update automations set name='ترحيب بعد الاشتراك' where kind='welcome';
update automations set name='تذكير قبل انتهاء الاشتراك' where kind='renew';
update automations set name='متابعة محادثة دون رد' where kind='followup';
update automations set name='تحديث المرحلة تلقائياً' where kind='stage';
