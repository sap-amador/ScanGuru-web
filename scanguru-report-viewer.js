/* ==========================================================================
   ScanGuru — shared report variant viewer  (v1)

   One study produces one prediction. Clinical / Research / Patient are three
   renderings of that same analysis, served by
       GET /studies/{id}/report.pdf?type=clinical|research|patient
   so the record must never list them as three separate reports.

   This module is the single viewer used wherever a stored report is opened:
   the dashboard studies table and the patient-detail timeline. The analysis
   modal's own success screen keeps its inline tabs — different surface,
   different lifecycle, deliberately not shared.

   Usage:
       ScanGuruReportViewer.open({
           studyId:     's_123',
           authedFetch: authed,          // (path, opts) => fetch Promise
           variant:     'research',      // optional, defaults to 'clinical'
           title:       'Chest X-ray',
           subtitle:    'Pneumonia · 91% · 24 Jul 14:02'
       });

   Notes:
     - Each variant gets its own AbortController (240s). Without one, a hung
       generation spins forever with no error and no way out.
     - Failures are retryable: nothing is cached on failure, so clicking the
       tab again refetches.
     - Blobs are cached per study for the life of the overlay and revoked on
       close.
   ========================================================================== */
(function (global) {
    'use strict';

    var TIMEOUT_MS = 240000;

    var VARIANTS = [
        { id: 'clinical', label: 'Clinical', icon: 'fa-stethoscope', sub: 'concise read' },
        { id: 'research', label: 'Research', icon: 'fa-microscope',  sub: 'full analysis' },
        { id: 'patient',  label: 'Patient',  icon: 'fa-users',       sub: 'plain language' }
    ];

    var CSS = [
        '.sgrv-overlay{position:fixed;inset:0;background:rgba(2,6,23,.78);z-index:9998;display:none;align-items:center;justify-content:center;padding:24px;}',
        '.sgrv-overlay.open{display:flex;}',
        '.sgrv-panel{background:var(--bg-card,#1E293B);border:1px solid var(--border,#334155);border-radius:16px;width:min(980px,100%);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;}',
        '.sgrv-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 22px;border-bottom:1px solid var(--border,#334155);}',
        '.sgrv-title{font-size:16px;font-weight:600;color:var(--text-primary,#F8FAFC);margin:0;}',
        '.sgrv-sub{font-size:13px;color:var(--text-secondary,#94A3B8);margin:3px 0 0;}',
        '.sgrv-x{background:none;border:none;color:var(--text-muted,#64748B);font-size:18px;cursor:pointer;padding:4px 8px;border-radius:8px;}',
        '.sgrv-x:hover{background:var(--bg-tertiary,#334155);color:var(--text-primary,#F8FAFC);}',
        '.sgrv-tabs{display:flex;gap:4px;padding:12px 22px 0;}',
        '.sgrv-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:9px 10px;background:transparent;border:1px solid var(--border,#334155);border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;font-family:inherit;font-size:13px;color:var(--text-secondary,#94A3B8);position:relative;top:1px;}',
        '.sgrv-tab:hover:not(.active){background:var(--bg-tertiary,#334155);color:var(--text-primary,#F8FAFC);}',
        '.sgrv-tab.active{background:var(--bg-card,#1E293B);border-color:var(--primary,#14B8A6);color:var(--primary,#14B8A6);font-weight:600;}',
        '.sgrv-tab i{font-size:14px;}',
        '.sgrv-tab .sgrv-tab-sub{font-size:10px;color:var(--text-muted,#64748B);}',
        '.sgrv-tab.active .sgrv-tab-sub{color:var(--primary,#14B8A6);}',
        '.sgrv-spin{display:inline-block;width:9px;height:9px;margin-right:5px;border:2px solid var(--border,#334155);border-top-color:var(--primary,#14B8A6);border-radius:50%;animation:sgrvSpin .8s linear infinite;vertical-align:middle;}',
        '@keyframes sgrvSpin{to{transform:rotate(360deg);}}',
        '.sgrv-note{font-size:11px;color:var(--text-muted,#64748B);padding:6px 22px 0;min-height:14px;}',
        '.sgrv-body{flex:1;padding:0 22px 18px;min-height:0;display:flex;}',
        '.sgrv-frame{width:100%;height:60vh;min-height:380px;border:1px solid var(--border,#334155);border-top:none;border-radius:0 0 10px 10px;background:#fff;}',
        '.sgrv-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--border,#334155);}',
        '.sgrv-btn{padding:9px 16px;border-radius:8px;border:1px solid var(--border,#334155);background:transparent;color:var(--text-secondary,#94A3B8);font-family:inherit;font-size:13px;cursor:pointer;}',
        '.sgrv-btn:hover{border-color:var(--primary,#14B8A6);color:var(--primary,#14B8A6);}',
        '.sgrv-btn[disabled]{opacity:.45;cursor:not-allowed;}',
        '@media (prefers-reduced-motion: reduce){.sgrv-spin{animation:none;}}'
    ].join('');

    var el = null;          // overlay root
    var state = {
        studyId: null,
        authedFetch: null,
        blobs: {},
        inFlight: {},
        active: null
    };

    function injectOnce() {
        if (el) return el;

        var style = document.createElement('style');
        style.id = 'sgrv-style';
        style.textContent = CSS;
        document.head.appendChild(style);

        el = document.createElement('div');
        el.className = 'sgrv-overlay';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'Report viewer');

        var tabsHtml = VARIANTS.map(function (v) {
            return '<button type="button" class="sgrv-tab" data-variant="' + v.id + '" role="tab">'
                 +   '<span><i class="fas ' + v.icon + '"></i> ' + v.label + '</span>'
                 +   '<span class="sgrv-tab-sub">' + v.sub + '</span>'
                 + '</button>';
        }).join('');

        el.innerHTML =
            '<div class="sgrv-panel">'
          +   '<div class="sgrv-head">'
          +     '<div><p class="sgrv-title" id="sgrv-title">Report</p>'
          +     '<p class="sgrv-sub" id="sgrv-sub"></p></div>'
          +     '<button class="sgrv-x" id="sgrv-close" aria-label="Close report viewer">'
          +       '<i class="fas fa-times"></i></button>'
          +   '</div>'
          +   '<div class="sgrv-tabs" id="sgrv-tabs" role="tablist">' + tabsHtml + '</div>'
          +   '<div class="sgrv-note" id="sgrv-note"></div>'
          +   '<div class="sgrv-body">'
          +     '<iframe class="sgrv-frame" id="sgrv-frame" title="Report preview" src="about:blank"></iframe>'
          +   '</div>'
          +   '<div class="sgrv-foot">'
          +     '<button class="sgrv-btn" id="sgrv-newtab" disabled>Open in new tab</button>'
          +     '<button class="sgrv-btn" id="sgrv-download" disabled>Download</button>'
          +   '</div>'
          + '</div>';

        document.body.appendChild(el);

        el.querySelector('#sgrv-close').addEventListener('click', close);
        el.addEventListener('click', function (ev) { if (ev.target === el) close(); });

        el.querySelector('#sgrv-tabs').addEventListener('click', function (ev) {
            var t = ev.target.closest && ev.target.closest('.sgrv-tab');
            if (t) select(t.dataset.variant);
        });

        el.querySelector('#sgrv-newtab').addEventListener('click', function () {
            var u = state.blobs[state.active];
            if (u) window.open(u, '_blank');
        });
        el.querySelector('#sgrv-download').addEventListener('click', function () {
            var u = state.blobs[state.active];
            if (!u) return;
            var a = document.createElement('a');
            a.href = u;
            a.download = 'ScanGuru_' + state.active + '_' + (state.studyId || 'report') + '.pdf';
            document.body.appendChild(a);
            a.click();
            a.remove();
        });

        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && el.classList.contains('open')) close();
        });

        return el;
    }

    function subFor(id) {
        for (var i = 0; i < VARIANTS.length; i++) if (VARIANTS[i].id === id) return VARIANTS[i].sub;
        return '';
    }

    function tabEl(id) {
        return el.querySelector('.sgrv-tab[data-variant="' + id + '"]');
    }

    function markFailed(id) {
        var t = tabEl(id); if (!t) return;
        t.dataset.failed = '1';
        var s = t.querySelector('.sgrv-tab-sub');
        if (s) { s.textContent = 'retry'; s.style.color = '#EF4444'; }
    }

    function clearFailed(id) {
        var t = tabEl(id); if (!t) return;
        delete t.dataset.failed;
        var s = t.querySelector('.sgrv-tab-sub');
        if (s) { s.textContent = subFor(id); s.style.color = ''; }
    }

    function setFootEnabled(on) {
        el.querySelector('#sgrv-newtab').disabled = !on;
        el.querySelector('#sgrv-download').disabled = !on;
    }

    async function select(variant) {
        variant = (variant || 'clinical').toLowerCase();
        if (!state.studyId) return;
        state.active = variant;

        el.querySelectorAll('.sgrv-tab').forEach(function (t) {
            var on = t.dataset.variant === variant;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
        });

        var frame = el.querySelector('#sgrv-frame');
        var note  = el.querySelector('#sgrv-note');
        var tab   = tabEl(variant);

        var cached = state.blobs[variant];
        if (cached) {
            frame.removeAttribute('srcdoc');   // srcdoc outranks src
            frame.src = cached;
            note.textContent = '';
            setFootEnabled(true);
            return;
        }

        if (state.inFlight[variant]) return;   // each retry is a full model run
        state.inFlight[variant] = true;

        clearFailed(variant);
        setFootEnabled(false);
        note.textContent = 'Generating the ' + variant + ' report — first view can take up to a minute.';
        if (tab && !tab.querySelector('.sgrv-spin')) {
            var sp = document.createElement('span');
            sp.className = 'sgrv-spin';
            tab.insertBefore(sp, tab.firstChild);
        }

        var controller = new AbortController();
        var timedOut = false;
        var timer = setTimeout(function () {
            timedOut = true;
            controller.abort();
        }, TIMEOUT_MS);

        try {
            var r = await state.authedFetch(
                '/studies/' + state.studyId + '/report.pdf?type=' + encodeURIComponent(variant),
                { signal: controller.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            var url = URL.createObjectURL(await r.blob());
            state.blobs[variant] = url;
            frame.removeAttribute('srcdoc');
            frame.src = url;
            note.textContent = '';
            setFootEnabled(true);
        } catch (e) {
            var isAbort = timedOut || e.name === 'AbortError';
            console.error('[report-viewer] ' + variant + ' failed:', e);
            markFailed(variant);
            frame.removeAttribute('src');
            frame.srcdoc =
                '<div style="padding:24px;font-family:sans-serif;color:#888;">'
              + '<b>Could not load the ' + variant + ' report.</b><br>'
              + (isAbort
                    ? 'It took longer than ' + (TIMEOUT_MS / 60000) + ' minutes to generate.'
                    : 'The server could not generate it.')
              + '<br><br>Click the tab again to retry, or try another tab.</div>';
            note.textContent = isAbort
                ? 'The ' + variant + ' report timed out — click the tab to retry.'
                : 'The ' + variant + ' report could not be generated — click the tab to retry.';
            setFootEnabled(false);
        } finally {
            clearTimeout(timer);
            delete state.inFlight[variant];
            if (tab) { var s = tab.querySelector('.sgrv-spin'); if (s) s.remove(); }
        }
    }

    function releaseBlobs() {
        Object.keys(state.blobs).forEach(function (k) {
            try { URL.revokeObjectURL(state.blobs[k]); } catch (e) {}
        });
        state.blobs = {};
        state.inFlight = {};
    }

    function open(opts) {
        opts = opts || {};
        if (!opts.studyId || typeof opts.authedFetch !== 'function') {
            console.warn('[report-viewer] open() needs studyId and authedFetch');
            return;
        }
        injectOnce();

        // A different study means the previous study's blobs are dead weight.
        if (state.studyId && state.studyId !== opts.studyId) releaseBlobs();

        state.studyId = opts.studyId;
        state.authedFetch = opts.authedFetch;

        el.querySelector('#sgrv-title').textContent = opts.title || 'Report';
        el.querySelector('#sgrv-sub').textContent = opts.subtitle || '';
        el.querySelectorAll('.sgrv-tab').forEach(function (t) { clearFailed(t.dataset.variant); });
        el.classList.add('open');
        document.body.style.overflow = 'hidden';

        select(opts.variant || 'clinical');
    }

    function close() {
        if (!el) return;
        el.classList.remove('open');
        document.body.style.overflow = '';
        var frame = el.querySelector('#sgrv-frame');
        frame.removeAttribute('srcdoc');
        frame.src = 'about:blank';
        releaseBlobs();
        state.studyId = null;
        state.active = null;
    }

    global.ScanGuruReportViewer = { open: open, close: close, VARIANTS: VARIANTS };

})(window);
