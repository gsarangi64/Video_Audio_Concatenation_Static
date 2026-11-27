(() => {
    const RATE = 44100;           // output sample rate; every input is resampled to this
    const $ = id => document.getElementById(id);
    const list = $('list'), status = $('status'), bar = $('bar'), result = $('result');
    let items = [];               // { id, file }
    let nextId = 0, dragId = null, lastUrl = null;

    const fmtSize = b => b > 1e6 ? (b/1e6).toFixed(1)+' MB' : Math.ceil(b/1e3)+' KB';
    const say = (msg, err=false) => { status.textContent = msg; status.className = err ? 'err' : ''; };

    function addFiles(files) {
        for (const f of files) {
            if (f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/i.test(f.name))
                items.push({ id: nextId++, file: f });
        }
        render();
    }

    function render() {
        list.innerHTML = '';
        items.forEach((it, i) => {
            const li = document.createElement('li');
            li.draggable = true;
            li.dataset.id = it.id;
            li.innerHTML = '<span class="grip" aria-hidden="true">⠿</span><span class="name"></span><span class="size"></span>' +
                '<button data-a="up" aria-label="Move up">↑</button><button data-a="down" aria-label="Move down">↓</button>' +
                '<button data-a="rm" aria-label="Remove">✕</button>';
            li.querySelector('.name').textContent = (i+1) + '. ' + it.file.name;
            li.querySelector('.size').textContent = fmtSize(it.file.size);
            li.querySelector('[data-a=up]').disabled = i === 0;
            li.querySelector('[data-a=down]').disabled = i === items.length - 1;
            list.appendChild(li);
        });
        $('join').disabled = items.length < 2;
        $('clear').disabled = items.length === 0;
    }

    list.addEventListener('click', e => {
        const a = e.target.dataset.a; if (!a) return;
        const i = items.findIndex(x => x.id == e.target.closest('li').dataset.id);
        if (a === 'rm') items.splice(i, 1);
        if (a === 'up' && i > 0) [items[i-1], items[i]] = [items[i], items[i-1]];
        if (a === 'down' && i < items.length-1) [items[i+1], items[i]] = [items[i], items[i+1]];
        render();
    });

    // Drag to reorder
    list.addEventListener('dragstart', e => { dragId = e.target.closest('li').dataset.id; e.target.closest('li').classList.add('dragging'); });
    list.addEventListener('dragend', e => { e.target.closest('li')?.classList.remove('dragging'); });
    list.addEventListener('dragover', e => e.preventDefault());
    list.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        const target = e.target.closest('li'); if (!target || dragId == null) return;
        const from = items.findIndex(x => x.id == dragId);
        const to = items.findIndex(x => x.id == target.dataset.id);
        items.splice(to, 0, items.splice(from, 1)[0]);
        dragId = null; render();
    });

    // File input and drop zone
    $('file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
    const drop = $('drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    $('clear').addEventListener('click', () => { items = []; render(); result.innerHTML = ''; say(''); });

    // Core: decode each file, resample to RATE, stack the samples end to end
    async function join() {
        $('join').disabled = true; result.innerHTML = ''; bar.hidden = false; bar.value = 0;
        if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
        const ctx = new AudioContext({ sampleRate: RATE });   // decodeAudioData resamples to this rate
        const parts = [];                                      // [{ l: Float32Array, r: Float32Array }]
        let total = 0;
        try {
            for (let i = 0; i < items.length; i++) {
                say(`Decoding ${i+1} of ${items.length}: ${items[i].file.name}`);
                const buf = await ctx.decodeAudioData(await items[i].file.arrayBuffer());
                const l = buf.getChannelData(0).slice();
                const r = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : l;  // mono -> both channels
                parts.push({ l, r }); total += l.length;
                bar.value = (i + 1) / items.length * 0.7;
            }
            const bytes = 44 + total * 4;
            if (bytes > 4294967295) throw new Error('Combined audio is over 4 GB, the WAV format limit.');

            say('Encoding WAV…');
            const wav = new DataView(new ArrayBuffer(bytes));
            const str = (o, s) => [...s].forEach((c, k) => wav.setUint8(o + k, c.charCodeAt(0)));
            str(0,'RIFF'); wav.setUint32(4, bytes - 8, true); str(8,'WAVE'); str(12,'fmt ');
            wav.setUint32(16,16,true); wav.setUint16(20,1,true); wav.setUint16(22,2,true);
            wav.setUint32(24,RATE,true); wav.setUint32(28,RATE*4,true); wav.setUint16(32,4,true); wav.setUint16(34,16,true);
            str(36,'data'); wav.setUint32(40, total * 4, true);
            const clip = x => { x = Math.max(-1, Math.min(1, x)); return x < 0 ? x * 0x8000 : x * 0x7fff; };
            let off = 44, done = 0;
            for (const p of parts) {
                for (let k = 0; k < p.l.length; k++, off += 4) {
                    wav.setInt16(off, clip(p.l[k]), true);
                    wav.setInt16(off + 2, clip(p.r[k]), true);
                }
                done += p.l.length; bar.value = 0.7 + 0.3 * done / total;
                await new Promise(r => setTimeout(r));             // yield so the page stays responsive
            }
            lastUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
            const mins = Math.floor(total / RATE / 60), secs = Math.round(total / RATE % 60);
            say(`Done: ${mins}m ${secs}s, ${fmtSize(bytes)}.`);
            result.innerHTML = `<audio controls src="${lastUrl}"></audio><a href="${lastUrl}" download="joined.wav">Download joined.wav</a>`;
        } catch (err) {
            say(err.name === 'EncodingError'
                ? 'One of the files could not be decoded. Check that all files are valid audio.'
                : 'Failed: ' + err.message, true);
        } finally {
            ctx.close(); bar.hidden = true; $('join').disabled = items.length < 2;
        }
    }
    $('join').addEventListener('click', join);
    render();
})();