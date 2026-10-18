/* Quran Researcher — UI strings, Arabic and English.
 *
 * Every piece of interface text lives here as  key: [arabic, english]  so the two versions sit side by
 * side. A value can be a plural table ({one, two, few, other}, picked with Intl.PluralRules from vars.n)
 * and can hold {name} placeholders. Values are trusted markup: callers escape any data they pass in.
 * Static HTML uses data-i18n (text), data-i18n-html, data-i18n-title, data-i18n-aria and
 * data-i18n-placeholder; data-i18n-n gives the count for a plural entry.
 *
 * Never translated (data, not UI): Quran text, Arabic words / roots / lemmas, the English translation
 * and word glosses, surah names, theme names from the server (shown per language by app.js), refs.
 * index.html sets <html lang dir> before first paint; this file only switches it afterwards.
 */
(() => {
  'use strict';

  const W = {
    // ---------------------------------------------------------------- page, header
    'doc.title': ['باحث القرآن', 'Quran Researcher'],
    'brand.title': ['باحث القرآن', 'Quran Researcher'],
    'brand.sub': ['أنماط القرآن ومعانيه', 'patterns & meanings'],
    'views.aria': ['طرق العرض', 'Views'],
    'view.search': ['بحث', 'Search'],
    'view.roots': ['شبكة الجذور', 'Root network'],
    'view.phrases': ['العبارات المتكررة', 'Repeated phrases'],
    'q.label': ['ابحث في القرآن', 'Search the Quran'],
    'q.ph': ['كلمة، جذر، آية أو موضوع…', 'Word, root, ayah or topic…'],
    'mode.aria': ['نوع الاستعلام', 'Query type'],
    'mode.auto': ['تلقائي', 'Auto'],
    'mode.word': ['كلمة', 'Word'],
    'mode.root': ['جذر', 'Root'],
    'mode.topic': ['موضوع', 'Topic'],
    'mode.ayah': ['آية', 'Ayah'],
    'scope.aria': ['النطاق', 'Scope'],
    'scope.all': ['الكل', 'All'],
    'scope.meccan': ['مكي', 'Meccan'],
    'scope.medinan': ['مدني', 'Medinan'],
    'n.aria': ['حجم الشبكة: عدد الآيات التي ترسمها الشبكة', 'Graph size: how many ayat the network draws'],
    'n.title': ['حجم الشبكة\nعدد الآيات الأكثر صلة التي تُرسم في الشبكة، أو كل المواضع.\nالشبكة الكبيرة تُفتح على خريطة المحاور، وكل محور يُفتح عند الطلب.\nقائمة النتائج تعرض كل المواضع دائمًا.',
      'Graph size\nHow many of the most relevant ayat are drawn in the network, or every match.\nA large graph opens on the theme map; each theme opens on demand.\nThe results list always shows every match.'],
    'n.opt': ['الشبكة {n}', 'Graph {n}'],
    'n.all': ['الشبكة: كل المواضع', 'Graph: every match'],
    'go': ['ابحث', 'Search'],
    'theme.title': ['الوضع الفاتح / الداكن', 'Light / dark theme'],
    'theme.toLight': ['التبديل إلى الوضع الفاتح', 'Switch to light theme'],
    'theme.toDark': ['التبديل إلى الوضع الداكن', 'Switch to dark theme'],
    // the language button names the language it switches to, in that language
    'lang.btn': ['EN', 'ع'],
    'lang.aria': ['Switch to English', 'التبديل إلى العربية'],

    // ---------------------------------------------------------------- welcome
    'w.title': ['ابحث في القرآن بالكلمة أو الجذر أو الآية أو الموضوع', 'Search the Quran by word, root, ayah or topic'],
    'w.note': ['أداة بحث تعين على التدبّر، وليست تفسيرًا ولا فتوى. النص القرآني من تنزيل كما هو.',
      'A research aid for reflection, not tafsir or a fatwa. The Quran text is Tanzil’s, unchanged.'],
    'w.desc': ['تُنظَّم النتائج في <b>محاور</b> ← محاور فرعية ← آيات، وتُرسم الجذور والمعاني التي تربط بينها شبكةً.',
      'Results are organised into <b>themes</b> → sub-themes → ayat, with the roots and meanings that link them drawn as a network.'],
    'ex.word': ['كلمة', 'patience'],
    'ex.root': ['جذر', 'root'],
    'ex.name': ['اسم علم', 'Moses'],
    'ex.orphans': ['كلمة', 'orphans'],
    'ex.phrase': ['عبارة', 'Day of Judgement'],
    'ex.topicEn': ['موضوع بالإنجليزية', 'topic'],
    'ex.kursi': ['آية الكرسي', 'Ayat al-Kursi'],
    'ex.text': ['نص آية', 'ayah text'],

    // ---------------------------------------------------------------- phrases view
    'ph.title': ['العبارات المتكررة', 'Repeated phrases'],
    'ph.titleSub': ['(من 3 إلى 7 كلمات)', '(3–7 words)'],
    'ph.desc': ['تسلسلات كلمات مطابقة تتكرر في أكثر من آية (المتشابهات). قد تختلف علامات الإعراب.',
      'Exact word sequences that recur across ayat (<em>mutashābihāt</em>). Case endings may differ.'],
    'ph.filter': ['تصفية بكلمة…', 'Filter by word…'],
    'ph.filterAria': ['تصفية العبارات', 'Filter phrases'],
    'ph.graph': ['ارسم هذه العبارة ←', 'Graph this phrase →'],
    'ph.none': ['لا توجد عبارات', 'No phrases'],
    'ph.pick': ['اختر مرجعًا لقراءة الآية', 'Click a reference to read the ayah'],

    // ---------------------------------------------------------------- counts (plural tables)
    'cnt.ayat': [{ one: 'آية واحدة', two: 'آيتان', few: '{n} آيات', other: '{n} آية' }, { one: '1 ayah', other: '{n} ayat' }],
    'cnt.roots': [{ one: 'جذر واحد', two: 'جذران', few: '{n} جذور', other: '{n} جذرًا' }, { one: '1 root', other: '{n} roots' }],
    'cnt.words': [{ one: 'كلمة واحدة', two: 'كلمتان', few: '{n} كلمات', other: '{n} كلمة' }, { one: '1 word', other: '{n} words' }],
    'cnt.themes': [{ zero: 'لا محاور', one: 'محور واحد', two: 'محوران', few: '{n} محاور', other: '{n} محورًا' }, { one: '1 theme', other: '{n} themes' }],
    'cnt.occ': [{ one: 'مرة واحدة', two: 'مرتان', few: '{n} مرات', other: '{n} مرة' }, { one: '1 occurrence', other: '{n} occurrences' }],

    // ---------------------------------------------------------------- legend
    'lg.aria': ['أدوات الشبكة والمحاور', 'Graph controls and themes'],
    'lg.toggle': ['إخفاء أو إظهار أدوات الشبكة', 'Hide or show the graph controls'],
    'lg.layout': ['التخطيط', 'Layout'],
    'layout.organized': ['منظّم', 'Organised'],
    'layout.radial': ['شعاعي', 'Radial'],
    'layout.free': ['حرّ', 'Free'],
    'layout.organizedT': ['المحاور صناديق على حلقة (1)', 'Themes as boxes on a ring (1)'],
    'layout.radialT': ['الآيات على دائرة مجمّعة حسب المحور (2)', 'Ayat on a circle, grouped by theme (2)'],
    'layout.freeT': ['تخطيط حرّ بكل الروابط، والمحاور مساحات حولها (3)', 'Free force layout with theme hulls (3)'],
    'btn.themesOnly': ['المحاور فقط', 'Themes only'],
    'btn.themesOnlyT': ['طيّ كل محور في صندوق واحد (T)', 'Collapse every theme into one box (T)'],
    'btn.reorg': ['⟳ أعد التنظيم', '⟳ Re-organise'],
    'btn.reorgT': ['أعد تشغيل التخطيط؛ العقد المثبّتة تبقى مكانها (R)', 'Re-run the layout; pinned nodes stay (R)'],
    'lg.nodes': ['العُقد', 'Nodes'],
    'key.query': ['الاستعلام', 'Query'],
    'key.seed': ['الآية المصدر', 'Source ayah'],
    'key.lex': ['آية فيها الكلمة', 'Ayah with the word'],
    'key.meaning': ['آية بالمعنى فقط', 'Related by meaning only'],
    'key.forms': ['البحث عن كلمة يعلّم صيغها الأخرى من الجذر نفسه بلون أخف', 'Searching a word marks its other forms of the same root lighter'],
    'key.root': ['جذر <small>(بين الصناديق: يربط المحاور)</small>', 'Root <small>(between boxes: links themes)</small>'],
    'key.related': ['≈ محور بالمعنى فقط', '≈ Theme of meaning-only matches'],
    'lg.links': ['الروابط', 'Links'],
    'edge.root': ['جذر مشترك', 'Shared root'],
    'edge.meaning': ['تشابه المعنى', 'Meaning'],
    'edge.phrase': ['عبارة مشتركة', 'Shared phrase'],
    'edge.tlink': ['بين المحاور', 'Theme ↔ theme'],
    'x.label': ['روابط عابرة للمحاور', 'Cross-theme links'],
    'x.focus': ['عند التحديد', 'On hover / focus'],
    'x.all': ['كلها (مجمّعة)', 'All (bundled)'],
    'x.none': ['إخفاء', 'Hidden'],
    'lg.color': ['التلوين', 'Colour by'],
    'color.theme': ['المحور', 'Theme'],
    'color.place': ['مكي/مدني', 'Meccan/Medinan'],
    'color.surah': ['السورة', 'Surah'],
    'ckey.surah': ['لكل سورة لونها · مرّر المؤشر على عقدة لمعرفة سورتها', 'Each surah has its own hue · hover a node for its surah'],
    'ckey.theme': ['اللون = صندوق المحور', 'Colour = theme box'],
    'lg.themes': ['المحاور', 'Themes'],
    'lg.themesHelp': ['نقرة: تركيز · ⊟ طيّ · ✎ إعادة تسمية · الشريط: <span style="color:var(--meccan)">مكي</span>/<span style="color:var(--medinan)">مدني</span>',
      'click: focus · ⊟ collapse · ✎ rename · bar: <span style="color:var(--meccan)">Meccan</span>/<span style="color:var(--medinan)">Medinan</span>'],
    'place.mk': ['مكية', 'Meccan'],
    'place.md': ['مدنية', 'Medinan'],

    // ---------------------------------------------------------------- toolbar, hint, help
    'graph.aria': ['الشبكة الموضوعية. المفاتيح: 1 منظّم، 2 شعاعي، 3 حرّ؛ الأسهم للتنقل بين الآيات؛ F ملاءمة؛ / بحث؛ ? مساعدة',
      'Thematic network. Keys: 1 organised, 2 radial, 3 free layout; arrows move between ayat; F fit; / find; ? help'],
    'find.ph': ['⌕ ابحث في الشبكة (/)', '⌕ Find in graph (/)'],
    'find.aria': ['البحث في الشبكة: رقم آية أو جذر أو كلمة', 'Find in graph: ayah number, root or word'],
    'find.notIn': ['ليست في الشبكة', 'not in graph'],
    'tb.fit': ['ملاءمة الشاشة (F)', 'Fit to screen (F)'],
    'tb.fitA': ['ملاءمة', 'Fit'],
    'tb.zoomOut': ['تصغير (−)', 'Zoom out (−)'],
    'tb.zoomOutA': ['تصغير', 'Zoom out'],
    'tb.zoomIn': ['تكبير (+)', 'Zoom in (+)'],
    'tb.zoomInA': ['تكبير', 'Zoom in'],
    'tb.labels': ['أب', 'Aa'],
    'tb.labelsT': ['على العقد: رقم · مقتطف · بلا (L)', 'On nodes: ref · snippet · none (L)'],
    'tb.labelsA': ['ما تعرضه عقد الآيات', 'What ayah nodes show'],
    'lbl.ref': ['رقم', 'Ref'],
    'lbl.snippet': ['مقتطف', 'Snippet'],
    'lbl.none': ['بلا', 'None'],
    'tb.unpinT': ['فكّ تثبيت كل العقد المسحوبة (U)', 'Unpin all dragged nodes (U)'],
    'tb.unpinA': ['فكّ تثبيت كل العقد', 'Unpin all nodes'],
    'tb.pngT': ['تصدير صورة PNG', 'Export PNG'],
    'tb.pngA': ['تصدير صورة PNG', 'Export as PNG image'],
    'tb.svgT': ['تصدير SVG (الصناديق والعقد؛ القطاعات الشعاعية والمساحات في PNG فقط)', 'Export SVG (boxes and nodes; radial sectors and hulls are PNG-only)'],
    'tb.svgA': ['تصدير SVG', 'Export as SVG'],
    'tb.helpT': ['مساعدة الفأرة ولوحة المفاتيح (?)', 'Keyboard & mouse help (?)'],
    'tb.helpA': ['مساعدة', 'Help'],
    'hint': ['اسحب أي عقدة أو صندوق محور · نقرة مزدوجة: توسيع · الزر الأيمن: كل الأوامر · ? مساعدة',
      'Drag nodes or whole theme boxes · double-click: expand · right-click: all actions · ? help'],
    'busy': ['…جارٍ البحث', 'Searching…'],
    'help.aria': ['مساعدة', 'Help'],
    'help.close': ['إغلاق', 'Close'],
    'help.title': ['التحكم', 'Controls'],
    'help.mouse': ['الفأرة', 'Mouse'],
    'help.keys': ['لوحة المفاتيح', 'Keys'],
    'help.mouseList': [
      '<li><b>الزر الأيمن</b> (أو ضغطة طويلة) على أي عقدة أو شبكة: كل الأوامر مع اختصاراتها</li>'
      + '<li>كل بحث يضيف شبكة إلى المساحة · Shift+Enter: بدلًا من الشبكة النشطة · ↗ في أي مكان: شبكة مرتبطة بالعقدة</li>'
      + '<li>اسحب ★ لتحريك الشبكة كلها · نقرة مزدوجة على ★: طيّ الشبكة أو فتحها · انقر إطار شبكة لتصير النشطة</li>'
      + '<li>اسحب عقدة لتحريكها، فتبقى مثبّتة هناك (📌). Shift مع النقر: تثبيت أو فكّ · اسحب صندوق محور لتحريك المحور كله</li>'
      + '<li>انقر عقدة لتفاصيلها، وتبقى مضاءة بروابطها حتى تنقر فراغًا · انقر صندوقًا للتركيز على المحور</li>'
      + '<li>نقرة مزدوجة على آية أو جذر: أضف آيات قريبة منها · على صندوق: طيّه أو فتحه</li>'
      + '<li>العجلة أو القرص: تكبير وتصغير · سحب الخلفية: تحريك العرض</li>',
      '<li><b>Right-click</b> (or long-press) a node or a network: every action with its shortcut</li>'
      + '<li>Every search adds a network · Shift+Enter: replace the active one · ↗ anywhere: a network linked to that node</li>'
      + '<li>Drag ★: move the whole network · double-click ★: fold / open it · click a frame: make it the active network</li>'
      + '<li>Drag a node: move it. It stays pinned there (📌). Shift-click: pin / unpin · drag a theme box: move the whole theme</li>'
      + '<li>Click a node: details, and it stays lit with its links until you click empty space · click a box: focus theme</li>'
      + '<li>Double-click ayah/root: pull in related ayat · double-click a box: collapse / expand it</li>'
      + '<li>Wheel / pinch: zoom · drag background: pan</li>'],
    'help.sources': ['<b>المصادر:</b> نص القرآن والتفسير الميسر وترجمة صحيح إنترناشونال من <a href="https://tanzil.net" target="_blank" rel="noopener">tanzil.net</a> · الصرف والجذور: Quranic Arabic Corpus (mustafa0x/quran-morphology) · المتشابهات: Waqar144/Quran_Mutashabihat_Data · الموضوعات: QSAC · نموذج المعاني: intfloat/multilingual-e5-small',
      '<b>Sources:</b> Quran text, Tafsir al-Muyassar and Sahih International from <a href="https://tanzil.net" target="_blank" rel="noopener">tanzil.net</a> · morphology and roots: Quranic Arabic Corpus (mustafa0x/quran-morphology) · similar passages: Waqar144/Quran_Mutashabihat_Data · topics: QSAC · meaning model: intfloat/multilingual-e5-small'],
    'help.keyList': [
      '<li><kbd>1</kbd> منظّم · <kbd>2</kbd> شعاعي · <kbd>3</kbd> حرّ (للشبكة النشطة) · <kbd>R</kbd> إعادة التنظيم · <kbd>Shift+R</kbd> كل الشبكات</li>'
      + '<li><kbd>{</kbd><kbd>}</kbd> الشبكة السابقة / التالية · <kbd>Delete</kbd> إزالة الشبكة النشطة · <kbd>⌘Z</kbd> تراجع</li>'
      + '<li><kbd>→</kbd><kbd>←</kbd> الآية السابقة / التالية · <kbd>Enter</kbd> التفاصيل · <kbd>N</kbd> ملاحظة على المحدد</li>'
      + '<li><kbd>[</kbd><kbd>]</kbd> المحور السابق / التالي · <kbd>Esc</kbd> مسح التحديد</li>'
      + '<li><kbd>C</kbd> طيّ المحور المحدد · <kbd>T</kbd> المحاور فقط · <kbd>Shift+T</kbd> طيّ كل الشبكات</li>'
      + '<li><kbd>P</kbd> تثبيت المحدد · <kbd>U</kbd> فكّ تثبيت الكل</li>'
      + '<li><kbd>F</kbd> ملاءمة · <kbd>Shift+F</kbd> ملاءمة الكل · <kbd>+</kbd><kbd>−</kbd> تكبير وتصغير · <kbd>L</kbd> نص الآيات على العقد · <kbd>/</kbd> بحث في الشبكة</li>'
      + '<li>تعمل الاختصارات بمواضع المفاتيح نفسها على لوحة المفاتيح العربية</li>',
      '<li><kbd>1</kbd> organised · <kbd>2</kbd> radial · <kbd>3</kbd> free (active network) · <kbd>R</kbd> re-organise · <kbd>Shift+R</kbd> all networks</li>'
      + '<li><kbd>{</kbd><kbd>}</kbd> previous / next network · <kbd>Delete</kbd> remove the active network · <kbd>⌘Z</kbd> undo</li>'
      + '<li><kbd>←</kbd><kbd>→</kbd> previous / next ayah · <kbd>Enter</kbd> details · <kbd>N</kbd> note on the selection</li>'
      + '<li><kbd>[</kbd><kbd>]</kbd> previous / next theme · <kbd>Esc</kbd> clear</li>'
      + '<li><kbd>C</kbd> collapse focused theme · <kbd>T</kbd> themes only · <kbd>Shift+T</kbd> fold all networks</li>'
      + '<li><kbd>P</kbd> pin selected · <kbd>U</kbd> unpin all</li>'
      + '<li><kbd>F</kbd> fit · <kbd>Shift+F</kbd> fit all · <kbd>+</kbd><kbd>−</kbd> zoom · <kbd>L</kbd> ayah text on nodes · <kbd>/</kbd> find</li>'
      + '<li>Shortcuts follow key positions, so they work on an Arabic layout too</li>'],

    // ---------------------------------------------------------------- side panel, results
    'side.aria': ['اللوحة الجانبية', 'Side panel'],
    'tab.results': ['النتائج', 'Results'],
    'tab.detail': ['التفاصيل', 'Details'],
    'tab.node': ['الجذر المحدد', 'Selected root'],
    'tab.root': ['الجذر {r}', 'Root {r}'],
    'node.ayat': ['{n} في هذه الشبكة فيها هذا الجذر', '{n} in this network contain this root'],
    'node.out': ['و{n} أخرى فيها هذا الجذر من نتائج البحث خارج الشبكة (أسفل القائمة)', 'plus {n} more of the search\'s matches with this root, outside the graph (further down)'],
    'node.outHead': ['مواضع أخرى فيها الجذر خارج الشبكة', 'Other matches with this root, outside the graph'],
    'node.closed': ['{n} منها في محاور مغلقة ({t})', '{n} of them are in closed themes ({t})'],
    'node.openAll': ['افتح محاورها', 'Open their themes'],
    'node.all': ['{n} في القرآن كله فيها هذا الجذر', '{n} in the whole Quran contain this root'],
    'node.search': ['ابحث بهذا الجذر', 'Search this root'],
    'node.mark': ['كلمات الجذر مسطّرة', 'the root\'s words are underlined'],
    'node.details': ['تفاصيل الجذر', 'Root details'],
    'node.release': ['✕ إلغاء التحديد', '✕ Release'],
    'node.releaseT': ['إلغاء تحديد الجذر والعودة إلى النتائج كاملة (Esc)', 'Release the root and go back to the full results (Esc)'],
    'node.aria': ['آيات الجذر المحدد', 'Ayat of the selected root'],
    'empty.start': ['ابدأ بالبحث', 'Start with a search'],
    'empty.pickNode': ['اختر عقدة من الشبكة', 'Pick a node in the graph'],
    'empty.pick': ['اختر آية أو جذرًا', 'Pick an ayah or root'],
    'kind.ayah': ['آية', 'Ayah'],
    'kind.root': ['جذر', 'Root'],
    'kind.word': ['كلمة', 'Word'],
    'kind.topic': ['موضوع', 'Topic'],
    'kind.roots': ['شبكة الجذور', 'Root network'],
    'res.semOff': ['البحث بالمعنى غير مفعّل (شغّل ملف الإعداد)', 'semantic search off (run setup)'],
    'what.root': ['الجذر', 'the root'],
    'what.word': ['الكلمة', 'the word'],
    'what.words': ['إحدى الكلمات', 'any of the words'],
    'scope.inMeccan': [' في السور المكية', ' in Meccan surahs'],
    'scope.inMedinan': [' في السور المدنية', ' in Medinan surahs'],
    // the full list: every match, the graph's ayat first (Arabic uses «label: number» to avoid number agreement)
    'counts.total': ['الآيات التي فيها {what}{scope}: <b>{n}</b>، كلها في القائمة أدناه', '<b>{n}</b> ayat contain {what}{scope}, all listed below'],
    'counts.drawn': ['المرسوم منها في الشبكة: <b>{n}</b>', '<b>{n}</b> of them drawn in the graph'],
    'counts.after': ['بعدها: <b>{n}</b>', '<b>{n}</b> more after them'],
    'counts.rel': ['فيها كلمات أخرى من جذرها (تعليم أخف): <b>{n}</b>', '<b>{n}</b> with other words of its root (lighter mark)'],
    'counts.meaning': ['ذات صلة بالمعنى (إطار متقطع): <b>{n}</b>', '<b>{n}</b> related by meaning (dashed)'],
    'counts.simple': ['الآيات: <b>{n}</b>', '<b>{n}</b> ayat'],
    'counts.withWords': ['فيها الكلمات: {n}', '{n} contain the words'],
    'chip.root': ['{c} · {ayat}', '{c} · {ayat}'],
    'chip.or': ['أو', 'or'],
    'chip.orT': ['الكلمة نفسها بمعنى آخر', 'The same word in another sense'],
    'banner.weak': ['⚠︎ لا ترد أيٌّ من هذه الكلمات في نص القرآن ولا في الترجمة، فهذه الآيات تخمينات تقريبية بالمعنى. جرّب كلمة عربية أو جذرًا (ص ب ر) أو عبارة إنجليزية أوضح.',
      '⚠︎ None of these words occur in the Quran\'s text or the translation, so these ayat are loose guesses by meaning. Try an Arabic word, a root (<span lang="ar">ص ب ر</span>) or a clearer English phrase.'],
    'banner.rest': ['ⓘ ترسم الشبكة الآيات الأكثر صلة ({lex} من {total}، حسب «حجم الشبكة» في الشريط العلوي)، وكل المواضع الأخرى مدرجة بعدها بترتيب المصحف · {jump}',
      'ⓘ The graph draws the {lex} most relevant of the {total} (graph size, top bar). Every other occurrence is listed after them in Mushaf order · {jump}'],
    'banner.jump': ['انتقل إلى المواضع الأخرى ({n}) ↓', 'jump to the other {n} ↓'],
    'sort.aria': ['ترتيب النتائج', 'Sort results'],
    'sort.label': ['التجميع:', 'Group:'],
    'sort.theme': ['حسب المحور', 'by theme'],
    'sort.rank': ['حسب الصلة', 'by relevance'],
    'rest.aria': ['مواضع أخرى خارج الشبكة', 'Other occurrences not in the graph'],
    'rest.title': ['مواضع أخرى خارج الشبكة', 'Other occurrences not in the graph'],
    'rest.sub': ['بترتيب المصحف', 'Mushaf order'],
    'rest.end': ['— نهاية القائمة —', '— end of the list —'],
    'rest.loading': ['…جارٍ التحميل', 'Loading…'],
    'rest.retry': ['⟳ أعد المحاولة', '⟳ Retry'],
    'rest.more': ['تحميل المزيد (بقي {n})', 'Load more ({n} left)'],
    'card.aria': ['الآية {ref}، سورة {s}', 'Ayah {ref}, {s}'],
    'tag.source': ['المصدر', 'source'],
    'tag.pulled': ['مضافة', 'pulled in'],
    'why.lexical': ['لفظي', 'lexical'],
    'why.root': ['الجذر نفسه', 'same root'],
    'why.meaning': ['المعنى {v}', 'meaning {v}'],

    // ---------------------------------------------------------------- details: bar, ayah, reader
    'bar.aria': ['التنقل في النتائج', 'Results navigation'],
    'bar.back': ['→ النتائج', '← Results'],
    'bar.backT': ['العودة إلى قائمة النتائج', 'Back to the results list'],
    'bar.backNode': ['→ آيات الجذر', '← Root\'s ayat'],
    'bar.backNodeT': ['العودة إلى آيات الجذر المحدد', 'Back to the selected root\'s ayat'],
    'bar.prevT': ['النتيجة السابقة في القائمة', 'Previous result in the list'],
    'bar.prevA': ['النتيجة السابقة', 'Previous result'],
    'bar.nextT': ['النتيجة التالية في القائمة', 'Next result in the list'],
    'bar.nextA': ['النتيجة التالية', 'Next result'],
    'bar.posT': ['موضعها في قائمة النتائج', 'Position in the results list'],
    'bar.pulled': ['· منها {n} بالتوسيع', '· incl. {n} pulled in'],
    'bar.outT': ['هذه الآية ليست في قائمة النتائج؛ ↑ ↓ يكملان من حيث تركتها', 'This ayah is not in the results list; ↑ ↓ continue from where you left it'],
    'd.title': ['سورة {name} · {ref}', 'Surah {tname} · {ref}'],
    'd.sub': ['{place} · ترتيب النزول {order}', '{ename} · {name} · {place} · revelation order {order}'],
    'd.nextT': ['الآية التالية {ref}', 'Next ayah {ref}'],
    'd.nextA': ['الآية التالية', 'Next ayah'],
    'd.prevT': ['الآية السابقة {ref}', 'Previous ayah {ref}'],
    'd.prevA': ['الآية السابقة', 'Previous ayah'],
    'reader.aria': ['الآية {ref} في سورتها: مرّر لرؤية ما قبلها وما بعدها', 'Ayah {ref} in its surah: scroll for the ayat before and after it'],
    'reader.openT': ['افتح {ref}', 'Open {ref}'],
    'reader.openA': ['افتح الآية {ref}', 'Open ayah {ref}'],
    'reader.start': ['بداية سورة <b>{s}</b>', 'Start of surah <b>{s}</b>'],
    'reader.end': ['نهاية سورة <b>{s}</b> · عدد آياتها {n}', 'End of surah <b>{s}</b> ({n} ayat)'],
    'd.trans': ['(ترجمة صحيح إنترناشونال)', '(Sahih International)'],
    'd.similarBtn': ['ابحث عن آيات مشابهة', 'Graph similar ayat'],
    'd.tafsir': ['التفسير الميسر', 'Tafsir al-Muyassar (Arabic)'],
    'h.wbw': ['كلمة بكلمة <small>انقر الجذر لملفه</small>', 'Word by word <small>click a root</small>'],
    'w.rootT': ['آيات الجذر {r}', 'Ayat with root {r}'],
    'h.topics': ['وسوم <small>وسوم موضوعية آلية (QSAC)</small>', 'Topic tags <small>machine-generated, QSAC</small>'],
    'h.similar': ['آيات مشابهة', 'Similar ayat'],
    'sim.aria': ['آيات مشابهة', 'Similar ayat'],
    'sim.meaning': ['بالمعنى', 'By meaning'],
    'sim.roots': ['بالجذور', 'By roots'],
    'sim.phrase': ['بالعبارة ({n})', 'By phrase ({n})'],
    'sim.curated': [' · متشابه ✓', ' · mutashabih ✓'],
    'sim.none': ['لا توجد عبارات مشتركة', 'No shared phrases'],

    // ---------------------------------------------------------------- details: root
    'r.label': ['جذر', 'Root'],
    'r.search': ['ابحث بهذا الجذر', 'Search this root'],
    'r.expand': ['+ أضف آياته إلى الشبكة', '+ Pull its ayat into the graph'],
    'r.occ': ['المواضع', 'occurrences'],
    'r.ayat': ['الآيات', 'ayat'],
    'r.surahs': ['السور', 'surahs'],
    'r.mkmd': ['مكي / مدني', 'Meccan / Medinan'],
    'lean.even': ['موزّع بالتساوي', 'evenly spread'],
    'lean.mk': ['يميل إلى المكي (+{n} نقطة عن معدل القرآن)', 'leans Meccan (+{n} pts vs corpus)'],
    'lean.md': ['يميل إلى المدني ({n} نقطة عن معدل القرآن)', 'leans Medinan ({n} pts vs corpus)'],
    'split.mk': ['مكي {p}%', 'Meccan {p}%'],
    'split.base': ['معدل القرآن {p}% مكي', 'corpus baseline {p}% Meccan'],
    'split.md': ['مدني {p}%', 'Medinan {p}%'],
    'r.dist': ['التوزيع عبر السور <small>عدد المواضع في كل سورة من 1 إلى 114</small>', 'Distribution across surahs <small>occurrences per surah 1 → 114</small>'],
    'r.distA': ['عدد المواضع في كل سورة', 'Occurrences per surah'],
    'dist.top': ['الأكثر في السور: {list}', 'Most in surah: {list}'],
    'r.lemmas': ['الصيغ <small>انقر للبحث</small>', 'Lemmas <small>click to search</small>'],
    'r.cooc': ['جذور مقترنة <small>تجتمع معه في الآيات نفسها (PPMI)</small>', 'Co-occurring roots <small>found in the same ayat (PPMI)</small>'],

    // ---------------------------------------------------------------- graph canvas + tooltips
    'g.byMeaning': ['بالمعنى', 'by meaning'],
    'g.pulled': ['مضافة', 'pulled in'],
    'g.part': ['فرع {k}', 'Part {k}'],
    'tt.phrase': ['عبارة مشتركة', 'Shared phrase'],
    'tt.meaning': ['تشابه المعنى {w}', 'Meaning similarity {w}'],
    'tt.tlink': ['بين المحورين', 'Between themes'],
    'tt.tlinkInfo': ['روابط المعنى: {m} · روابط العبارة: {p} · جذور مشتركة: {r}', '{m} meaning · {p} phrase links · {r} shared roots'],
    'tt.cooc': ['اقتران (PPMI) {w}', 'Co-occurrence (PPMI) {w}'],
    'tt.root': ['جذر · {occ}', 'Root · {occ}'],
    'tt.bridge': [' · يربط عدة محاور', ' · links several themes'],
    'tt.rootHelp': ['نقرة: آياته · نقرة مزدوجة: ابحث به', 'Click: its ayat · double-click: search it'],
    'tt.rootHelpSearch': ['نقرة: آياته وحدها (نقرة أخرى تلغي التحديد) · نقرة مزدوجة: أضف آياته', 'Click: only its ayat (click again to release) · double-click: pull in its ayat'],
    'tt.theme': ['محور · {size}', 'Theme · {size}'],
    'tt.themeRoots': ['الجذور: {r}', 'Roots: {r}'],
    'tt.themeHelp': ['نقرة: تركيز · نقرة مزدوجة: طيّ · سحب: تحريك المحور', 'Click: focus · double-click: collapse · drag: move the theme'],
    'tt.sub': ['فرع · {size}', 'Sub-theme · {size}'],
    'tt.query': ['الاستعلام', 'Query'],

    // ---------------------------------------------------------------- theme list
    'comm.mkbar': ['مكية: {mk} · مدنية: {md}', '{mk} Meccan · {md} Medinan'],
    'comm.focusA': ['التركيز على المحور {t}، {n}', 'Focus theme {t}, {n}'],
    'comm.renameT': ['أعد تسمية هذا المحور', 'Rename this theme'],
    'comm.renameA': ['إعادة تسمية المحور {t}', 'Rename theme {t}'],
    'comm.colT': ['طيّ / فتح (C)', 'Collapse / expand (C)'],
    'comm.colA': ['طيّ المحور {t}', 'Collapse theme {t}'],
    'comm.expA': ['فتح المحور {t}', 'Expand theme {t}'],
    'comm.newName': ['اسم المحور الجديد', 'New theme name'],

    // ---------------------------------------------------------------- root network
    'net.desc': ['الجذور الأوسع انتشارًا ({n})، بعد حذف الشائعة جدًا مثل أ ل ه، ق و ل، مجمّعة في محاور ({t}). يرتبط جذران إذا اجتمعا في الآيات نفسها أكثر مما تقتضيه الصدفة (PPMI). انقر جذرًا لعرض آياته، وانقر مرتين للبحث به.',
      'The {n} most widespread roots (very common ones like <span lang="ar">أ ل ه، ق و ل</span> removed), grouped into {t} themes. Two roots are linked when they appear together in the same ayat more often than chance (PPMI). Click a root to list its ayat; double-click to search it.'],
    'empty.netFail': ['تعذّر تحميل شبكة الجذور', 'Could not load the root network'],

    // ---------------------------------------------------------------- suggestions
    'sug.root': ['جذر', 'root'],
    'sug.lemma': ['كلمة', 'lemma'],
    'sug.surah': ['سورة', 'surah'],

    // ---------------------------------------------------------------- toasts, errors
    'toast.pinned': ['📌 ثُبّتت في هذا التخطيط، وتبقى مكانها عند إعادة التنظيم', '📌 Pinned in this layout. It stays put when you re-organise'],
    'toast.unpinned': ['أُلغي التثبيت', 'Unpinned'],
    'toast.allUnpinned': ['كل العقد حرة', 'All nodes unpinned'],
    'toast.bigMap': ['خريطة المحاور: {ayat} في {themes} · افتح محورًا (نقرة مزدوجة أو ⊞) لترى آياته',
      'Theme map: {ayat} in {themes} · open a theme (double-click or ⊞) to see its ayat'],
    'toast.stillExpanding': ['…ما زالت التوسعة السابقة تُضاف', 'Still adding the previous expansion…'],
    'toast.nothingNew': ['لا جديد للإضافة', 'Nothing new to add'],
    'toast.added': ['أضيفت {ayat} إلى «{t}»', 'Added {ayat} to «{t}»'],
    'toast.expandFail': ['تعذّر التوسيع: {e}', 'Could not expand: {e}'],
    'toast.noAyah': ['لا توجد آية بهذا الرقم: {e}', 'No such ayah: {e}'],
    'toast.err': ['خطأ: {e}', 'Error: {e}'],
    'toast.restFail': ['تعذّر تحميل بقية النتائج: {e}', 'Could not load more results: {e}'],
    'toast.ayahFail': ['تعذّر فتح الآية: {e}', 'Could not open the ayah: {e}'],
    'toast.ctxFail': ['تعذّر تحميل الآيات المجاورة: {e}', 'Could not load the nearby ayat: {e}'],
    'toast.rootFail': ['تعذّر فتح الجذر: {e}', 'Could not open the root: {e}'],
    'toast.netFail': ['تعذّر تحميل شبكة الجذور: {e}', 'Could not load the root network: {e}'],
    'toast.svgNote': ['ملف SVG فيه العقد والروابط؛ القطاعات الشعاعية والمساحات في تصدير PNG', 'SVG has the nodes and links; the radial sectors / hulls are in the PNG export'],
    'toast.svgFail': ['تعذّر تصدير SVG: {e}', 'SVG export failed: {e}'],
    'web.py': ['…تحميل محرك البحث (أول زيارة فقط تحتاج بعض الوقت)', 'Loading the search engine… (only the first visit takes a while)'],
    'web.data': ['…تحميل نص القرآن والفهارس', 'Loading the Quran text and indexes…'],
    'web.engine': ['…تجهيز الفهارس', 'Preparing the indexes…'],
    'web.model': ['…تحميل نموذج المعاني {p}% من {mb} م.ب (مرة واحدة)', 'Loading the meaning model {p}% of {mb} MB (once)…'],
    'web.modelFail': ['تعذّر تحميل نموذج المعاني، فلا يعمل إلا البحث بالجذر والآية. أعد تحميل الصفحة', 'The meaning model could not load, so only root and ayah searches work. Reload the page'],
    'web.fail': ['تعذّر تحميل محرك البحث. تحقق من الاتصال ثم أعد تحميل الصفحة', 'The search engine could not load. Check your connection and reload the page'],
    'layout.toFull': ['العرض الكامل (كالحاسوب)', 'Full layout (as on a computer)'],
    'layout.toPhone': ['عرض الهاتف', 'Phone layout'],
    'opts.title': ['خيارات البحث: النوع والنطاق وحجم الشبكة', 'Search options: type, scope and network size'],
    'sheet.aria': ['اسحب لتكبير اللوحة أو تصغيرها', 'Drag to resize the panel'],
    'install.title': ['ثبّت التطبيق', 'Install the app'],
    'install.ios': ['<li>افتح قائمة المشاركة (المربع والسهم ⬆︎)</li><li>اختر «إضافة إلى الشاشة الرئيسية»</li>', '<li>Open the Share menu (the square with the arrow ⬆︎)</li><li>Choose “Add to Home Screen”</li>'],
    'install.mac': ['<li>في Safari: قائمة «ملف» ← «إضافة إلى Dock»</li>', '<li>In Safari: File menu → “Add to Dock”</li>'],
    'install.note': ['بعد أول تحميل كامل يعمل التطبيق دون اتصال بالإنترنت.', 'After the first full load the app works without an internet connection.'],
    'install.done': ['تم تثبيت التطبيق', 'The app is installed'],
    'err.offline': ['الخادم المحلي لا يستجيب؛ شغّله بالأمر ./run.sh', 'The local server is not answering · start it with ./run.sh'],
    'err.server': ['خطأ في الخادم {n}', 'Server error {n}'],
    // notes and errors the server writes in English (qr/engine.py, qr/server.py), matched in note() below
    'note.surahAyas': ['سورة {s} فيها {ayat} فقط', 'surah {s} has {n} ayat'],
    'note.trimmed': ['اقتُصر النطاق على أول {n} آية ({a}–{b})', 'range trimmed to the first {n} ayat ({a}–{b})'],
    'note.cut': ['اقتُصر الاستعلام على أول {n} حرف', 'query cut to its first {n} characters'],
    'note.notRoot': ['ليس جذرًا معروفًا، فبُحث عنه موضوعًا', 'not a known root, so this was searched as a topic'],
    'note.oneSurah': ['يجب أن يبقى النطاق داخل سورة واحدة', 'ranges must stay within one surah'],
    'note.noAyah': ['لا توجد الآية {q}', 'no ayah {q}'],
    'note.backwards': ['النطاق {r} ينتهي قبل أن يبدأ', 'range {r} ends before it starts'],
    'note.empty': ['الاستعلام فارغ', 'empty query'],
    'note.busy': ['طلبات كثيرة، انتظر دقيقة', 'too many requests, wait a minute'],
    'note.tooLong': ['الاستعلام طويل جدًا (الحد {n} حرف)', 'query too long (max {n} characters)'],
    'note.noRoot': ['لا يوجد الجذر {r}', 'no root {r}'],
    'note.noNode': ['عقدة غير معروفة {x}', 'unknown node {x}'],
    'note.noSurah': ['لا توجد السورة {s}', 'no surah {s}'],
    'note.internal': ['خطأ داخلي في الخادم', 'internal error'],

    // ---------------------------------------------------------------- workspace: networks on one canvas
    'ws.networks': ['الشبكات', 'Networks'],
    'ws.network': ['شبكة', 'Network'],
    'ws.dup': ['هذا البحث موجود في المساحة', 'Already on the canvas'],
    'ws.from': ['↗ شبكة مرتبطة · من {src} في {net}', '↗ linked network · from {src} in {net}'],
    'ws.freeze': ['تجميد', 'Freeze'],
    'ws.unfreeze': ['فكّ التجميد', 'Unfreeze'],
    'ws.frozen': ['مجمّدة', 'Frozen'],
    'ws.frozenOn': ['جُمّدت شبكة «{q}»: لا تتغيّر حتى تفكّ تجميدها', 'Network “{q}” is frozen: it won’t change until you unfreeze it'],
    'ws.frozenOff': ['فُكّ تجميد شبكة «{q}»', 'Network “{q}” unfrozen'],
    'ws.frozenNo': ['الشبكة مجمّدة؛ فكّ تجميدها لتغييرها', 'Frozen: unfreeze to change it'],
    'ws.frozenT': ['الشبكة مجمّدة', 'The network is frozen'],
    'ws.frozenBranch': ['الشبكة مجمّدة، ففُتحت النتائج في شبكة مرتبطة', 'Frozen, so the results opened as a linked network'],
    'ws.frozenAdd': ['الشبكة النشطة مجمّدة، فأُضيفت شبكة جديدة', 'The active network is frozen, so a new one was added'],
    'ws.fold': ['طيّ الشبكة', 'Fold network'],
    'ws.unfold': ['فتح الشبكة', 'Open network'],
    'ws.foldOthers': ['طيّ البقية', 'Fold others'],
    'ws.foldAll': ['طيّ الكل', 'Fold all'],
    'ws.foldAllToggle': ['طيّ الكل / فتح الكل', 'Fold all / open all'],
    'ws.remove': ['إزالة الشبكة', 'Remove network'],
    'ws.removed': ['أُزيلت شبكة «{q}»', 'Removed “{q}”'],
    'ws.undo': ['تراجع', 'Undo'],
    'ws.refined': ['أُعيد البحث في الشبكة نفسها', 'The network was searched again in place'],
    'ws.rename': ['إعادة تسمية', 'Rename'],
    'ws.renameT': ['اسم الشبكة', 'Network name'],
    'ws.alsoIn': [{ one: 'في شبكة أخرى أيضًا', two: 'في شبكتين أخريين أيضًا', few: 'في {n} شبكات أخرى أيضًا', other: 'في {n} شبكة أخرى أيضًا' },
      { one: 'also in 1 other network', other: 'also in {n} other networks' }],
    'ws.alsoInLab': ['في شبكات أخرى:', 'Also in:'],
    'ws.sharedLab': ['مشتركة مع', 'Shared with'],
    'ws.sharedT': ['أضئ الآيات المشتركة بين الشبكتين', 'Light the ayat the two networks share'],
    'ws.hydrating': ['… تُستعاد نصوص الآيات من المصحف', '… restoring the ayah texts from the corpus'],
    'ws.restored': ['استُعيد المشروع: {n}', 'Project restored: {n}'],
    'sw.title': ['الشبكة النشطة · انقر للتبديل بين الشبكات ({ })', 'Active network · click to switch ({ })'],
    'sw.menu': ['أوامر الشبكة', 'Network actions'],
    'm.fit': ['ملاءمة الشبكة', 'Fit network'],
    'm.fitAll': ['ملاءمة الكل', 'Fit all'],
    'm.note': ['ملاحظة', 'Note'],
    'm.copyLink': ['نسخ رابط البحث', 'Copy search link'],
    'm.copied': ['نُسخ', 'Copied'],
    'm.details': ['التفاصيل', 'Details'],
    'm.pull': ['توسيع: آيات قريبة منها', 'Pull in related ayat'],
    'm.pullRoot': ['توسيع: آياته هنا', 'Pull in its ayat here'],
    'm.similar': ['آيات مشابهة ↗', 'Similar ayat ↗'],
    'm.fullText': ['اعرض النص كاملًا', 'Show full text'],
    'm.hideText': ['أخفِ النص', 'Hide text'],
    'm.pin': ['تثبيت / فكّ التثبيت', 'Pin / unpin'],
    'm.copy': ['نسخ الآية مع مرجعها', 'Copy with reference'],
    'm.rootHere': ['آياته في هذه الشبكة', 'Its ayat in this network'],
    'm.searchRoot': ['ابحث بهذا الجذر ↗', 'Search this root ↗'],
    'm.searchWord': ['ابحث بهذه الكلمة ↗', 'Search this word ↗'],
    'm.focus': ['تركيز', 'Focus'],
    'm.click': ['نقرة', 'click'],
    'm.dbl': ['نقرة مزدوجة', 'dbl-click'],
    'lad.title': ['المطابقة:', 'Match:'],
    'lad.form': ['اللفظ نفسه', 'Exact form'],
    'lad.lemma': ['الكلمة بتصاريفها', 'All inflections'],
    'lad.root': ['الجذر كله', 'Whole root'],
    'hdr.forms': ['الألفاظ الواردة:', 'Forms found:'],
    'hdr.formT': ['أضئ آيات هذا اللفظ (انقر مرة أخرى للإلغاء)', 'Light the ayat with this form (click again to clear)'],
    'hdr.siblings': ['كلمات أخرى من الجذر ↗:', 'Other words of the root ↗:'],
    'hdr.suggest': ['جرّب:', 'Try:'],
    'hdr.meaning': ['آيات بالمعنى', 'Ayat by meaning'],
    'grp.auto': ['التجميع: تلقائي', 'Group: auto'],
    'grp.form': ['التجميع: حسب الصيغة', 'Group: by form'],
    'grp.theme': ['التجميع: حسب المحور', 'Group: by theme'],
    'ref.scope': ['نطاق السور', 'Surah scope'],
    'ref.n': ['حجم الشبكة', 'Graph size'],
    'ref.group': ['التجميع', 'Grouping'],
    'n.auto': ['الشبكة: تلقائي', 'Graph: auto'],
    'q.title': ['Enter: شبكة جديدة · Shift+Enter: بدلًا من الشبكة النشطة', 'Enter: new network · Shift+Enter: replace the active network'],
    'chip.branchT': ['يُفتح في شبكة مرتبطة · Shift: بدلًا من الشبكة النشطة', 'Opens as a linked network · Shift: replaces the active one'],
    'find.count': ['{n} · {nets} شبكات', '{n} · {nets} networks'],
    'notes.unavailable': ['الملاحظات غير متاحة', 'Notes are unavailable'],
    'toast.copyFail': ['تعذّر النسخ', 'Could not copy'],
    'tt.queryHelp': ['اسحب ★ لتحريك الشبكة كلها · نقرة مزدوجة: طيّ · الزر الأيمن: الأوامر', 'Drag ★ to move the whole network · double-click: fold · right-click: actions'],
    'tt.form': ['صيغة · {size}', 'Form · {size}'],
    'w.branchT': ['ابحث بهذه الكلمة أو بجذرها في شبكة مرتبطة', 'Search this word or its root as a linked network'],
    'kind.phrase': ['عبارة', 'Phrase'],
    'what.phrase': ['العبارة', 'the phrase'],
    'lg.shared': ['الآيات المشتركة بين الشبكات', 'Ayat shared between networks'],
    'edge.anchor': ['رابط التفريع', 'Branch link'],
    'edge.form': ['صيغة أخرى للجذر', 'Another form of the root'],

    // ---- projects & notes (static/projects.js; keys pj.* and nt.*)
    'pj.chipAria': ['المشروع المفتوح', 'Open project'],
    'pj.untitled': ['مشروع بلا عنوان', 'Untitled project'],
    'pj.nameIt': ['سمِّه', 'Name it'],
    'pj.renameT': ['انقر لإعادة تسمية المشروع', 'Click to rename the project'],
    'pj.namePrompt': ['اسم المشروع', 'Project name'],
    'pj.menuT': ['المشاريع', 'Projects'],
    'pj.new': ['مشروع جديد', 'New project'],
    'pj.import': ['استيراد…', 'Import…'],
    'pj.clear': ['إزالة الشبكات غير المجمّدة', 'Remove unfrozen networks'],
    'pj.list': ['المشاريع المحفوظة', 'Saved projects'],
    'pj.open': ['فتح', 'Open'],
    'pj.rename': ['إعادة تسمية', 'Rename'],
    'pj.dup': ['تكرار', 'Duplicate'],
    'pj.export': ['تصدير', 'Export'],
    'pj.delete': ['حذف', 'Delete'],
    'pj.deleteConfirm': ['حذف نهائيًا؟', 'Delete for good?'],
    'pj.cancel': ['إلغاء', 'Cancel'],
    'pj.current': ['المفتوح الآن', 'open now'],
    'pj.edited': ['عُدّل {date}', 'Edited {date}'],
    'pj.nets': [{ zero: 'لا شبكات', one: 'شبكة واحدة', two: 'شبكتان', few: '{n} شبكات', other: '{n} شبكة' }, { one: '1 network', other: '{n} networks' }],
    'pj.notes': [{ zero: 'لا ملاحظات', one: 'ملاحظة واحدة', two: 'ملاحظتان', few: '{n} ملاحظات', other: '{n} ملاحظة' }, { one: '1 note', other: '{n} notes' }],
    'pj.empty': ['لا مشاريع بعد؛ أول بحث ينشئ مشروعًا', 'No projects yet; the first search creates one'],
    'pj.saving': ['يُحفظ…', 'Saving…'],
    'pj.saved': ['محفوظ', 'Saved'],
    'pj.saveFail': ['تعذّر الحفظ، صدّر المشروع', 'Couldn’t save, export the project'],
    'pj.otherTab': ['المشروع مفتوح في نافذة أخرى', 'Open in another window'],
    'pj.copyName': ['{name} (نسخة)', '{name} (copy)'],
    'pj.imported': ['استُورد المشروع «{name}»', 'Imported project “{name}”'],
    'pj.importFail': ['تعذّر الاستيراد: {e}', 'Import failed: {e}'],
    'pj.badFile': ['الملف ليس مشروعًا صالحًا', 'The file is not a valid project'],
    'pj.tooBig': ['الملف كبير جدًا (الحد 50 م.ب)', 'The file is too large (50 MB limit)'],
    'pj.deleted': ['حُذف المشروع «{name}»', 'Deleted project “{name}”'],
    'pj.openFail': ['تعذّر فتح المشروع: {e}', 'Could not open the project: {e}'],
    'pj.linkCopied': ['نُسخ رابط البحث', 'Search link copied'],
    'pj.copyFail': ['تعذّر النسخ', 'Could not copy'],
    'pj.legacyAdded': ['أُضيف البحث «{q}» إلى المشروع', 'Search “{q}” added to the project'],
    'pj.undo': ['تراجع', 'Undo'],
    'pj.thumbAlt': ['صورة مصغّرة للمشروع', 'Project thumbnail'],
    'nt.tab': ['ملاحظات', 'Notes'],
    'nt.label': ['ملاحظة', 'Note'],
    'nt.add': ['＋ ملاحظة', '+ Note'],
    'nt.ph': ['اكتب ملاحظتك…', 'Write a note…'],
    'nt.saved': ['حُفظت', 'Saved'],
    'nt.delete': ['حذف الملاحظة', 'Delete note'],
    'nt.esc': ['Esc: العودة إلى الشبكة', 'Esc: back to the graph'],
    'nt.refs': ['مراجع في الملاحظة:', 'References in the note:'],
    'nt.search': ['ملاحظة على البحث', 'Search note'],
    'nt.project': ['ملاحظة المشروع', 'Project note'],
    'nt.projectPh': ['ما تبحث عنه في هذا المشروع…', 'What this project is about…'],
    'nt.filterAria': ['نطاق الملاحظات', 'Notes scope'],
    'nt.thisNet': ['هذه الشبكة', 'This network'],
    'nt.whole': ['المشروع كله', 'Whole project'],
    'nt.export': ['تصدير الملاحظات', 'Export notes'],
    'nt.empty': ['لا ملاحظات بعد. اختر آية أو جذرًا واضغط N أو «＋ ملاحظة»', 'No notes yet. Pick an ayah or root and press N or “+ Note”'],
    'nt.emptyNet': ['لا ملاحظات على عناصر هذه الشبكة', 'No notes on this network’s items'],
    'nt.ayat': ['الآيات', 'Ayat'],
    'nt.roots': ['الجذور', 'Roots'],
    'nt.words': ['الكلمات', 'Words'],
    'nt.nets': ['الشبكات', 'Networks'],
    'nt.onAyah': ['ملاحظة على الآية {ref}', 'Note on ayah {ref}'],
    'nt.onRoot': ['ملاحظة على الجذر {r}', 'Note on root {r}'],
    'nt.onWord': ['ملاحظة على الكلمة {w}', 'Note on word {w}'],
    'nt.onNet': ['ملاحظة على شبكة «{q}»', 'Note on network “{q}”'],
    'nt.mdTitle': ['ملاحظات المشروع «{name}»', 'Notes of project “{name}”'],
    'nt.mdSrc': ['النص القرآني من tanzil.net، بالرسم العثماني كما هو', 'Quran text from tanzil.net, Uthmani script unchanged'],
    'nt.openT': ['افتح {what}', 'Open {what}'],
  };

  // server text → key + vars; the English original is shown as is in English mode
  const NOTES = [
    [/^surah (\d+) has (\d+) ayat$/, (m) => ['note.surahAyas', { s: m[1], n: +m[2], ayat: t('cnt.ayat', { n: +m[2] }) }]],
    [/^range trimmed to the first (\d+) ayat \((\S+)–(\S+)\)$/, (m) => ['note.trimmed', { n: m[1], a: m[2], b: m[3] }]],
    [/^query cut to its first (\d+) characters$/, (m) => ['note.cut', { n: m[1] }]],
    [/^not a known root, so this was searched as a topic$/, () => ['note.notRoot']],
    [/^ranges must stay within one surah$/, () => ['note.oneSurah']],
    [/^no ayah (.+)$/, (m) => ['note.noAyah', { q: m[1] }]],
    [/^range (\S+) ends before it starts$/, (m) => ['note.backwards', { r: m[1] }]],
    [/^empty query$/, () => ['note.empty']],
    [/^too many requests, wait a minute$/, () => ['note.busy']],
    [/^query too long \(max (\d+) characters\)$/, (m) => ['note.tooLong', { n: m[1] }]],
    [/^no root (.+)$/, (m) => ['note.noRoot', { r: m[1] }]],
    [/^unknown node (.+)$/, (m) => ['note.noNode', { x: m[1] }]],
    [/^no surah (\d+)$/, (m) => ['note.noSurah', { s: m[1] }]],
    [/^internal error$/, () => ['note.internal']],
  ];

  const PR = { ar: new Intl.PluralRules('ar'), en: new Intl.PluralRules('en') };
  let lang = document.documentElement.lang === 'ar' ? 'ar' : 'en';

  function t(key, vars) {
    const e = W[key];
    if (!e) { console.warn('i18n: no string', key); return key; }
    let s = e[lang === 'ar' ? 0 : 1];
    if (typeof s === 'object') s = s[PR[lang].select(Number(vars && vars.n) || 0)] ?? s.other;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
  }

  // a server note / error message in the UI language (plain text: the caller escapes it)
  function note(msg) {
    if (lang === 'en' || !msg) return msg;
    for (const [re, f] of NOTES) {
      const m = re.exec(msg);
      if (m) { const [k, v] = f(m); return t(k, v); }
    }
    return msg;
  }

  function applyStatic(root = document) {
    const each = (attr, fn) => root.querySelectorAll(`[${attr}]`).forEach((el) => {
      const n = el.getAttribute('data-i18n-n');
      fn(el, t(el.getAttribute(attr), n != null ? { n } : undefined));
    });
    each('data-i18n', (el, s) => { el.textContent = s; });
    each('data-i18n-html', (el, s) => { el.innerHTML = s; });
    each('data-i18n-title', (el, s) => { el.title = s; });
    each('data-i18n-aria', (el, s) => { el.setAttribute('aria-label', s); });
    each('data-i18n-placeholder', (el, s) => { el.placeholder = s; });
    if (root === document) document.title = t('doc.title');
  }

  function setLang(l, save = true) {
    if (l !== 'ar' && l !== 'en') return;
    lang = l;
    const h = document.documentElement;
    h.lang = l; h.dir = l === 'ar' ? 'rtl' : 'ltr';
    if (save) try { localStorage.setItem('qr-lang', l); } catch (_) { /* storage blocked */ }
    applyStatic();
  }

  window.I18N = { t, note, applyStatic, setLang, get lang() { return lang; } };
})();
