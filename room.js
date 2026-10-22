        (function () {
            if (document.documentElement.dataset.embed === "1") return;

            const enterBtn = document.getElementById("room-enter");
            const exitBtn = document.getElementById("room-exit");
            const layer = document.getElementById("room-layer");
            const prompt = document.getElementById("room-prompt");
            const crossEl = document.querySelector(".hud-cross");
            const rotateGate = document.getElementById("room-rotate");
            const rotateCancel = document.getElementById("room-rotate-cancel");
            const stickEl = document.getElementById("touch-stick");
            const nubEl = document.getElementById("touch-nub");
            // "USE / STAND" -- sit at the desk. Distinct from the mode button below.
            const deskBtn = document.getElementById("touch-desk");
            const glCanvas = document.getElementById("room-gl");
            const overlay = document.getElementById("monitor-overlay");
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

            if (!enterBtn || !layer) return;

            // HTML-in-Canvas (chrome://flags/#canvas-draw-element). When present, the page
            // can be captured into a real GPU texture. The page is a live DOM element on the
            // screen in every view (see syncMonitorPage); the texture is only what the
            // black hole bends, since a DOM element cannot be lensed.
            const HTML_CANVAS_SUPPORTED = (function () {
                try {
                    const probe = document.createElement("canvas").getContext("2d");
                    return !!probe && typeof probe.drawElementImage === "function";
                } catch (error) {
                    return false;
                }
            })();

            // A touch device gets the stick-and-look scheme; everything else gets pointer
            // lock. This is about the input available, not the screen width -- a small
            // window on a desktop should still use the mouse.
            function isTouchDevice() {
                return window.matchMedia("(pointer: coarse)").matches ||
                    (navigator.maxTouchPoints || 0) > 0;
            }

            function isLandscape() {
                return window.matchMedia("(orientation: landscape)").matches ||
                    window.innerWidth > window.innerHeight;
            }

            const ROOM_SCRIPTS = [
                "vendor/GLTFLoader.js",
                "vendor/LineSegmentsGeometry.js",
                "vendor/LineMaterial.js",
                "vendor/LineSegments2.js"
            ];
            const CHAIR_MODEL_URLS = ["models/chair.glb"];
            // The screen is 0.80 x 0.45 world units, exactly 16:9, so the page's logical
            // size matches its aspect and no letterboxing is needed.
            const SCREEN_CSS_W = 1152;
            const SCREEN_CSS_H = 648;
            // The capture is rendered at 2x that and downsampled by the GPU, so the texture
            // still resolves text cleanly at the size the panel actually occupies.
            const STAGE_SCALE = 2;
            const STAGE_W = SCREEN_CSS_W * STAGE_SCALE;
            const STAGE_H = SCREEN_CSS_H * STAGE_SCALE;
            const scriptLoads = Object.create(null);
            const gltfCache = Object.create(null);
            let roomLibs = null;
            let maxAnisotropy = 1;

            // Adaptive resolution. Rendering at the device's full pixel ratio is what keeps
            // the room as sharp as the 2D page, but a 3x phone is drawing nine times the
            // fragments of a 1x one and not every phone can. Watch real frame times and
            // give back resolution only when the device cannot keep up -- fast hardware
            // never leaves full density.
            const RES_STEPS = [1, 1.25, 1.5, 2, 2.5, 3];
            const FRAME_SLOW = 24;      // ms -- below ~42fps
            const FRAME_FAST = 13;      // ms -- comfortably above 60fps
            let resIndex = RES_STEPS.length - 1;
            let resSamples = [];
            let resSettleAt = 0;

            function targetPixelRatio() {
                return Math.min(window.devicePixelRatio || 1, RES_STEPS[resIndex]);
            }

            function adaptResolution(now, dtMs) {
                if (!room || !player.playing || blackHole) return;
                resSamples.push(dtMs);
                if (resSamples.length < 40) return;
                const avg = resSamples.reduce((a, b) => a + b, 0) / resSamples.length;
                resSamples.length = 0;
                if (now < resSettleAt) return;
                const before = resIndex;
                if (avg > FRAME_SLOW && resIndex > 0) resIndex -= 1;
                else if (avg < FRAME_FAST && resIndex < RES_STEPS.length - 1) resIndex += 1;
                if (resIndex === before) return;
                // A resize reallocates buffers, so leave room between adjustments.
                resSettleAt = now + 2500;
                room.renderer.setPixelRatio(targetPixelRatio());
                markRender();
            }

            function loadScript(src) {
                if (!scriptLoads[src]) {
                    scriptLoads[src] = new Promise((resolve, reject) => {
                        const el = document.createElement("script");
                        el.src = src;
                        el.onload = resolve;
                        el.onerror = () => reject(new Error("Failed to load " + src));
                        document.head.appendChild(el);
                    });
                }
                return scriptLoads[src];
            }

            function loadGltf(url) {
                if (!gltfCache[url]) {
                    gltfCache[url] = new Promise((resolve, reject) => {
                        if (typeof THREE === "undefined" || typeof THREE.GLTFLoader === "undefined") {
                            reject(new Error("GLTFLoader unavailable"));
                            return;
                        }
                        new THREE.GLTFLoader().load(url, resolve, undefined, reject);
                    });
                }
                return gltfCache[url];
            }

            function prefetchModels() {
                CHAIR_MODEL_URLS.forEach((url) => {
                    loadGltf(url).catch(() => {});
                });
            }

            function ensureRoomLibs() {
                if (!roomLibs) {
                    roomLibs = (async () => {
                        if (typeof THREE === "undefined") throw new Error("three.js unavailable");
                        for (const src of ROOM_SCRIPTS) await loadScript(src);
                        prefetchModels();
                    })();
                }
                return roomLibs;
            }

            // Phones pay for this on a metered connection and may never open the room, so
            // only desktops prefetch; mobile loads on demand behind the rotate gate.
            if (!isTouchDevice()) {
                // Build the room too, while the page is idle, so the click that enters it finds it
                // ready instead of waiting on a WebGL context, geometry and shader compiles.
                const startPrefetch = () => {
                    keySound.prefetch();
                    ensureRoomLibs().then(() => {
                        if (room) return;
                        room = createRoom();
                        room.renderer.compile(room.scene, room.camera);
                    }).catch(() => { room = null; });
                };
                if (window.requestIdleCallback) {
                    window.requestIdleCallback(startPrefetch, { timeout: 1200 });
                } else {
                    window.addEventListener("load", startPrefetch, { once: true });
                }
            }

            let room = null;

            const tmpEye = new THREE.Vector3();

            function cssColor(name) {
                return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
            }

            // The room is line art, drawn the way the game draws its own (aeos-core
            // game/line_art): every solid is filled with the background colour, so the depth
            // buffer hides whatever sits behind it, and its creases are inked over the top.
            // No lights, no textures, no shadow map, so the whole room is a handful of draws.
            // The theme supplies everything: --bg, a grey between --bg and --fg, and the
            // accent (pure red on modus-vivendi, pure blue on modus-operandi).
            const CREASE = 40;           // degrees; a fold sharper than this gets a line
            const PHI = 1.618034;
            const UNIT_BOX = (() => {
                const box = new THREE.BoxGeometry(1, 1, 1);
                return {
                    faces: box.toNonIndexed().attributes.position.array,
                    edges: new THREE.EdgesGeometry(box, CREASE).attributes.position.array
                };
            })();

            function roomPalette() {
                const bg = cssColor("--bg");
                return {
                    bg: bg,
                    ink: cssColor("--border"),
                    accent: cssColor("--cube-color")
                };
            }

            // Lines are a few pixels wide, as quads in screen space (three's examples/lines), not
            // GL lines, which are always one device pixel: far edges thin out to nothing and
            // slanted ones alias. The game draws its lines 2 px wide, antialiased by coverage.
            // The width is in CSS pixels.
            const LINE_PX = 2;

            function lineMaterial(color, vertexColors) {
                return new THREE.LineMaterial({ color: color.getHex(), linewidth: LINE_PX, vertexColors: !!vertexColors });
            }

            // Lines of these points, in this material, as one mesh. `positions` is pairs of
            // points ([x1, y1, z1, x2, y2, z2, ...]), and is kept: writing into it and marking
            // geometry.attributes.instanceStart.data (and instanceColorStart.data) updates it.
            function fatLines(positions, material, colors) {
                const geometry = new THREE.LineSegmentsGeometry().setPositions(positions);
                if (colors) geometry.setColors(colors);
                return new THREE.LineSegments2(geometry, material);
            }

            // The pairs of points along a run of [x, y, z] points, closed back to the first if asked.
            function runSegments(points, closed) {
                const out = [];
                const n = closed ? points.length : points.length - 1;
                for (let i = 0; i < n; i++) out.push(points[i], points[(i + 1) % points.length]);
                return new Float32Array(out.flat());
            }

            function makeMats(p) {
                const line = lineMaterial(p.ink);
                const accentLine = lineMaterial(p.accent);
                // Vertex colours do the colouring; white leaves them as they are.
                const keyLine = lineMaterial(new THREE.Color(1, 1, 1), true);
                return {
                    lineList: [line, accentLine, keyLine],
                    // Pushed back a little, so a solid's own edges (and lines lying on its face) win
                    // the depth test instead of flickering against it.
                    face: new THREE.MeshBasicMaterial({
                        color: p.bg,
                        side: THREE.DoubleSide,
                        polygonOffset: true,
                        polygonOffsetFactor: 1,
                        polygonOffsetUnits: 16
                    }),
                    line,
                    accentLine,
                    keyLine,
                    accentFace: new THREE.MeshBasicMaterial({ color: p.accent, side: THREE.DoubleSide })
                };
            }

            function applyPalette(r) {
                const p = roomPalette();
                r.palette = p;
                r.mats.face.color.copy(p.bg);
                r.mats.line.color.copy(p.ink);
                r.mats.accentLine.color.copy(p.accent);
                r.mats.accentFace.color.copy(p.accent);
                if (r.keyboard) r.keyboard.recolor(p);
                // Switched off, the screen is just a dark pane; with a page baked on, the map rules.
                if (!r.screenGlass.material.map) r.screenGlass.material.color.copy(p.bg);
                r.scene.background = p.bg;
                r.renderer.setClearColor(p.bg, 1);
            }

            // y-up metres, z towards the player. A transform from a position and, optionally,
            // a turn about y and a tilt about x.
            function place(x, y, z, ry, rx) {
                return new THREE.Matrix4()
                    .makeRotationFromEuler(new THREE.Euler(rx || 0, ry || 0, 0))
                    .setPosition(x, y, z);
            }

            // Collects solids already in world space and turns them into a few meshes: the
            // faces, the inked edges, and the accent's own lines and fills.
            function makeArt(mats) {
                const faces = [];
                const edges = [];
                const accentEdges = [];
                const accentFaces = [];
                const world = (geometry, matrix) =>
                    (geometry.index ? geometry.toNonIndexed() : geometry.clone())
                        .applyMatrix4(matrix).attributes.position.array;
                const flat = (list) => {
                    const out = new Float32Array(list.reduce((n, a) => n + a.length, 0));
                    let at = 0;
                    list.forEach((a) => { out.set(a, at); at += a.length; });
                    return out;
                };
                const join = (list) => new THREE.BufferGeometry()
                    .setAttribute("position", new THREE.BufferAttribute(flat(list), 3));
                // Most solids are boxes, so a box skips the generic path: one unit cube's faces and
                // twelve edges, stretched and moved into place.
                const at = new THREE.Vector3();
                const carry = (source, matrix) => {
                    const out = new Float32Array(source.length);
                    for (let i = 0; i < source.length; i += 3) {
                        at.set(source[i], source[i + 1], source[i + 2]).applyMatrix4(matrix).toArray(out, i);
                    }
                    return out;
                };
                const art = {
                    faces(geometry, matrix) { faces.push(world(geometry, matrix)); },
                    edges(geometry, matrix) {
                        edges.push(world(new THREE.EdgesGeometry(geometry, CREASE), matrix));
                    },
                    solid(geometry, matrix) { art.faces(geometry, matrix); art.edges(geometry, matrix); },
                    // Already-made vertices, in world space.
                    raw(faceData, edgeData) { faces.push(faceData); edges.push(edgeData); },
                    box(w, h, d, matrix) {
                        const m = matrix.clone().scale(at.set(w, h, d));
                        faces.push(carry(UNIT_BOX.faces, m));
                        edges.push(carry(UNIT_BOX.edges, m));
                    },
                    accentBox(w, h, d, matrix) { accentFaces.push(world(new THREE.BoxGeometry(w, h, d), matrix)); },
                    // Lines from point to point ([x, y, z] each), closed back to the first if asked.
                    line(points, accent, closed) {
                        (accent ? accentEdges : edges).push(runSegments(points, closed));
                    },
                    build(parent) {
                        const made = [];
                        const add = (object) => { parent.add(object); made.push(object); };
                        if (faces.length) add(new THREE.Mesh(join(faces), mats.face));
                        if (edges.length) add(fatLines(flat(edges), mats.line));
                        if (accentEdges.length) add(fatLines(flat(accentEdges), mats.accentLine));
                        if (accentFaces.length) add(new THREE.Mesh(join(accentFaces), mats.accentFace));
                        return made;
                    }
                };
                return art;
            }

            function ring(x, y, z, r, n) {
                const pts = [];
                for (let i = 0; i < n; i++) {
                    const t = (Math.PI * 2 * i) / n;
                    pts.push([x + r * Math.cos(t), y, z + r * Math.sin(t)]);
                }
                return pts;
            }

            // The keyboard on the desk is the game's (aeos-core game/keyboard.gd): a full-size ANSI
            // board of 104 keys that shows the visitor's own. Keys are matched by where they are
            // on the keyboard (KeyboardEvent.code), not what they type. A key pressed goes all
            // the way down on a critically damped spring, turns the accent colour, and stays
            // down, still, for as long as it is held; let go, it springs back. Neither way does
            // it bounce.
            const KB_U = 0.01905;            // a key unit, the distance between two keys' centres
            const KB_DEPTH = 0.005;          // how far a key goes down: a real one's 4 mm, and a
                                             // little more, so it shows from across the room
            const KB_SPRING = 80;

            const KB_LETTERS = (letters) => letters.split("").map((c) => "Key" + c);
            const KB_DIGITS = Array.from({ length: 10 }, (_, i) => "Digit" + ((i + 1) % 10));

            // Rows back to front: [y, keys], a key being a code, [code, width] or a gap (a
            // number), in key units from the board's back left corner.
            const KB_ROWS = [
                [0, ["Escape", 1, "F1", "F2", "F3", "F4", 0.5, "F5", "F6", "F7", "F8", 0.5, "F9", "F10", "F11", "F12",
                    0.25, "PrintScreen", "ScrollLock", "Pause"]],
                [1.5, ["Backquote", ...KB_DIGITS, "Minus", "Equal", ["Backspace", 2], 0.25, "Insert", "Home", "PageUp",
                    0.25, "NumLock", "NumpadDivide", "NumpadMultiply", "NumpadSubtract"]],
                [2.5, [["Tab", 1.5], ...KB_LETTERS("QWERTYUIOP"), "BracketLeft", "BracketRight", ["Backslash", 1.5],
                    0.25, "Delete", "End", "PageDown", 0.25, "Numpad7", "Numpad8", "Numpad9"]],
                [3.5, [["CapsLock", 1.75], ...KB_LETTERS("ASDFGHJKL"), "Semicolon", "Quote", ["Enter", 2.25],
                    3.5, "Numpad4", "Numpad5", "Numpad6"]],
                [4.5, [["ShiftLeft", 2.25], ...KB_LETTERS("ZXCVBNM"), "Comma", "Period", "Slash", ["ShiftRight", 2.75],
                    1.25, "ArrowUp", 1.25, "Numpad1", "Numpad2", "Numpad3"]],
                [5.5, [["ControlLeft", 1.25], ["MetaLeft", 1.25], ["AltLeft", 1.25], ["Space", 6.25], ["AltRight", 1.25],
                    ["MetaRight", 1.25], ["ContextMenu", 1.25], ["ControlRight", 1.25], 0.25, "ArrowLeft", "ArrowDown",
                    "ArrowRight", 0.25, ["Numpad0", 2], "NumpadDecimal"]]
            ];
            const KB_WIDTH = 22.5;           // the board's size in key units
            const KB_LENGTH = 6.5;

            // Every key as { code, x, y, w, h } in key units, the two tall numpad keys last.
            function keyboardLayout() {
                const keys = [];
                KB_ROWS.forEach(([y, row]) => {
                    let x = 0;
                    row.forEach((item) => {
                        if (typeof item === "number") {
                            x += item;
                            return;
                        }
                        const [code, w] = typeof item === "string" ? [item, 1] : item;
                        keys.push({ code, x, y, w, h: 1 });
                        x += w;
                    });
                });
                keys.push({ code: "NumpadAdd", x: 21.5, y: 2.5, w: 1, h: 2 }, { code: "NumpadEnter", x: 21.5, y: 4.5, w: 1, h: 2 });
                return keys;
            }

            // A solid from a bottom ring to a top ring of four corners each ([x, y, z]): its
            // sides and top as faces (no top, if `open`), and its twelve edges.
            function loftData(bottom, top, matrix, open) {
                const b = bottom.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(matrix));
                const t = top.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(matrix));
                const faces = [];
                const edges = [];
                const quad = (p, q, r, s) => faces.push(p, q, r, p, r, s);
                for (let i = 0; i < 4; i++) {
                    const j = (i + 1) % 4;
                    quad(b[i], b[j], t[j], t[i]);
                    edges.push(b[i], b[j], t[i], t[j], b[i], t[i]);
                }
                if (!open) quad(t[0], t[1], t[2], t[3]);
                const flat = (list) => Float32Array.from(list.flatMap((p) => [p.x, p.y, p.z]));
                return { faces: flat(faces), edges: flat(edges) };
            }

            // The board as a wedge case, higher at the back, and a tapered cap for each key. The
            // caps are their own meshes (faces and edges, the edges coloured per vertex), with
            // every key's vertices at known places in them, so a key pressed is a few writes.
            function makeKeyboard(mats, matrix, palette) {
                const layout = keyboardLayout();
                const n = layout.length;
                const m = 0.009;
                const x0 = (-KB_WIDTH * KB_U) / 2;
                const z0 = (-KB_LENGTH * KB_U) / 2;
                const zEnd = z0 + KB_LENGTH * KB_U + m;
                const topAt = (z) => 0.026 + (0.017 - 0.026) * ((z - (z0 - m)) / (zEnd - (z0 - m)));
                const xa = x0 - m;
                const xb = -x0 + m;
                const za = z0 - m;
                const frame = loftData(
                    [[xa, 0, za], [xb, 0, za], [xb, 0, zEnd], [xa, 0, zEnd]],
                    [[xa, topAt(za), za], [xb, topAt(za), za], [xb, topAt(zEnd), zEnd], [xa, topAt(zEnd), zEnd]],
                    matrix);

                const faceBase = new Float32Array(n * 90);
                const lineBase = new Float32Array(n * 72);
                layout.forEach((k, i) => {
                    const a = x0 + k.x * KB_U + 0.0006;
                    const b = x0 + (k.x + k.w) * KB_U - 0.0006;
                    const c = z0 + k.y * KB_U + 0.0006;
                    const d = z0 + (k.y + k.h) * KB_U - 0.0006;
                    const h = topAt((c + d) / 2);
                    const data = loftData(
                        [[a, h, c], [b, h, c], [b, h, d], [a, h, d]],
                        [[a + 0.0025, h + 0.009, c + 0.0015], [b - 0.0025, h + 0.009, c + 0.0015],
                            [b - 0.0025, h + 0.009, d - 0.0035], [a + 0.0025, h + 0.009, d - 0.0035]],
                        matrix);
                    faceBase.set(data.faces, i * 90);
                    lineBase.set(data.edges, i * 72);
                });
                const facePos = faceBase.slice();
                const linePos = lineBase.slice();
                const lineColor = new Float32Array(n * 72);
                const faceColor = new Float32Array(n * 90);
                const faceGeo = new THREE.BufferGeometry()
                    .setAttribute("position", new THREE.BufferAttribute(facePos, 3))
                    .setAttribute("color", new THREE.BufferAttribute(faceColor, 3));

                faceGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
                faceGeo.attributes.color.setUsage(THREE.DynamicDrawUsage);
                // The caps' faces take the background colour, with the accent stirred in while a
                // key is down so a pressed key shows from across the room.
                const faceMat = new THREE.MeshBasicMaterial({
                    vertexColors: true,
                    side: THREE.DoubleSide,
                    polygonOffset: true,
                    polygonOffsetFactor: 1,
                    polygonOffsetUnits: 16
                });
                const lines = fatLines(linePos, mats.keyLine, lineColor);
                const lineGeo = lines.geometry;
                const meshes = [new THREE.Mesh(faceGeo, faceMat), lines];

                const index = {};
                layout.forEach((k, i) => { index[k.code] = i; });
                const held = new Uint8Array(n);
                const press = new Float32Array(n);
                const speed = new Float32Array(n);
                const bg = new THREE.Color();
                const ink = new THREE.Color();
                const accent = new THREE.Color();
                const tint = new THREE.Color();

                // Key i as it is now: down by press[i], its edges between ink and accent.
                function write(i) {
                    const down = press[i];
                    for (let v = i * 30; v < i * 30 + 30; v++) facePos[v * 3 + 1] = faceBase[v * 3 + 1] - down;
                    const t = Math.min(Math.max(down / KB_DEPTH, 0), 1);
                    tint.copy(bg).lerp(accent, 0.5 * t);
                    for (let v = i * 30; v < i * 30 + 30; v++) {
                        faceColor[v * 3] = tint.r;
                        faceColor[v * 3 + 1] = tint.g;
                        faceColor[v * 3 + 2] = tint.b;
                    }
                    tint.copy(ink).lerp(accent, t);
                    for (let v = i * 24; v < i * 24 + 24; v++) {
                        linePos[v * 3 + 1] = lineBase[v * 3 + 1] - down;
                        lineColor[v * 3] = tint.r;
                        lineColor[v * 3 + 1] = tint.g;
                        lineColor[v * 3 + 2] = tint.b;
                    }
                }

                function upload() {
                    faceGeo.attributes.position.needsUpdate = true;
                    faceGeo.attributes.color.needsUpdate = true;
                    lineGeo.attributes.instanceStart.data.needsUpdate = true;
                    lineGeo.attributes.instanceColorStart.data.needsUpdate = true;
                }

                const board = {
                    meshes,
                    frame,
                    moving: false,
                    recolor(p) {
                        bg.copy(p.bg);
                        ink.copy(p.ink);
                        accent.copy(p.accent);
                        for (let i = 0; i < n; i++) write(i);
                        upload();
                    },
                    // A key going down or coming up, by its code; the keys this board has not got
                    // are ignored.
                    hold(code, down) {
                        const i = index[code];
                        if (i !== undefined && held[i] !== +down) {
                            held[i] = +down;
                            board.moving = true;
                        }
                    },
                    releaseAll() {
                        held.fill(0);
                        board.moving = true;
                    },
                    // Moves the keys on their springs; false once they are all still, each exactly
                    // up or down.
                    step(dt) {
                        const sub = Math.max(1, Math.ceil(dt * 480));
                        const h = dt / sub;
                        let still = true;
                        for (let i = 0; i < n; i++) {
                            const to = held[i] ? KB_DEPTH : 0;
                            let x = press[i];
                            let v = speed[i];
                            if (x === to && v === 0) continue;
                            for (let j = 0; j < sub; j++) {
                                v += (KB_SPRING * KB_SPRING * (to - x) - 2 * KB_SPRING * v) * h;
                                x += v * h;
                            }
                            if (Math.abs(x - to) < 4e-6 && Math.abs(v) < 2e-4) {
                                x = to;
                                v = 0;
                            } else {
                                still = false;
                            }
                            press[i] = x;
                            speed[i] = v;
                            write(i);
                        }
                        upload();
                        board.moving = !still;
                        return board.moving;
                    }
                };
                board.recolor(palette);
                return board;
            }

            // The keys heard, as the game has them (aeos-core game/key_sounds.gd): recordings of
            // one membrane keyboard (CC0, audio/CREDITS.md). Pressing clicks and letting go
            // clacks softly; the long keys have sounds of their own, whose stabilizer bars make
            // them sound bigger. Every press picks a random take, never the last, varied a
            // little in pitch and level so fast typing does not machine-gun, and a held key's
            // auto-repeat makes no sound. The sound comes from the keyboard, as loud as flat at
            // 55 cm and 6 dB quieter each time the distance doubles. Leaned in to the screen
            // the keys go quiet, gliding to it about as fast as the lean.
            const KEY_SOUNDS = { key: [8, 6], space: [5, 4], enter: [4, 3], backspace: [4, 3], shift: [4, 3] };
            const KEY_GROUPS = {
                Space: "space", Enter: "enter", NumpadEnter: "enter",
                Backspace: "backspace", ShiftLeft: "shift", ShiftRight: "shift"
            };
            const KEY_VOLUME_DB = -6;
            const KEY_CENTRE_DB = 3;         // makes up for equal-power panning
            const KEY_JITTER_DB = 1.5;
            const KEY_PITCH = 0.03;
            const KEY_CLOSE_DB = -14;
            const KEY_GLIDE_DB = 12;         // a second

            const keySound = (() => {
                const names = [];
                Object.keys(KEY_SOUNDS).forEach((group) => {
                    ["press", "release"].forEach((kind, i) => {
                        for (let n = 1; n <= KEY_SOUNDS[group][i]; n++) names.push(group + "_" + kind + "_" + n);
                    });
                });
                let fetched = null;
                let ctx = null;
                let panner = null;
                let buffers = null;
                let leanDb = 0;
                const last = {};
                const gain = (db) => Math.pow(10, db / 20);
                const forward = new THREE.Vector3();
                const up = new THREE.Vector3();

                function fetchAll() {
                    if (!fetched) {
                        fetched = Promise.all(names.map((name) => fetch("audio/" + name + ".wav").then((r) => r.arrayBuffer())));
                    }
                    return fetched;
                }

                return {
                    // The files, ahead of the first key.
                    prefetch() {
                        fetchAll().catch(() => {});
                    },
                    // Called from the click that enters the room: browsers only start sound from a
                    // gesture. `at` is where the keyboard is.
                    start(at) {
                        const AudioCtx = window.AudioContext || window.webkitAudioContext;
                        if (!AudioCtx) return;
                        if (!ctx) {
                            ctx = new AudioCtx();
                            const master = ctx.createGain();
                            master.gain.value = gain(KEY_VOLUME_DB);
                            master.connect(ctx.destination);
                            panner = ctx.createPanner();
                            panner.panningModel = "equalpower";
                            panner.distanceModel = "inverse";
                            panner.refDistance = 0.55;
                            panner.rolloffFactor = 1;
                            panner.connect(master);
                            fetchAll().then((raw) => Promise.all(raw.map((data) => ctx.decodeAudioData(data.slice(0)))))
                                .then((list) => {
                                    // The takes of each sound, by "group_kind".
                                    const grouped = {};
                                    names.forEach((name, i) => {
                                        const key = name.replace(/_\d+$/, "");
                                        (grouped[key] = grouped[key] || []).push(list[i]);
                                    });
                                    buffers = grouped;
                                }).catch(() => {});
                        }
                        if (ctx.state === "suspended") ctx.resume();
                        if (at && panner.positionX) {
                            panner.positionX.value = at.x;
                            panner.positionY.value = at.y;
                            panner.positionZ.value = at.z;
                        } else if (at) {
                            panner.setPosition(at.x, at.y, at.z);
                        }
                    },
                    context() {
                        return ctx;
                    },
                    // Where the ears are: the camera.
                    listen(camera) {
                        if (!ctx) return;
                        const l = ctx.listener;
                        const p = camera.position;
                        camera.getWorldDirection(forward);
                        up.set(0, 1, 0).applyQuaternion(camera.quaternion);
                        if (l.positionX) {
                            l.positionX.value = p.x;
                            l.positionY.value = p.y;
                            l.positionZ.value = p.z;
                            l.forwardX.value = forward.x;
                            l.forwardY.value = forward.y;
                            l.forwardZ.value = forward.z;
                            l.upX.value = up.x;
                            l.upY.value = up.y;
                            l.upZ.value = up.z;
                        } else {
                            l.setPosition(p.x, p.y, p.z);
                            l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
                        }
                    },
                    glide(dt, close) {
                        const to = close ? KEY_CLOSE_DB : 0;
                        const step = KEY_GLIDE_DB * dt;
                        leanDb += Math.max(-step, Math.min(step, to - leanDb));
                    },
                    play(code, pressed) {
                        if (!buffers || !ctx || ctx.state !== "running") return;
                        const takes = buffers[(KEY_GROUPS[code] || "key") + (pressed ? "_press" : "_release")];
                        let pick = Math.floor(Math.random() * takes.length);
                        const id = (KEY_GROUPS[code] || "key") + (pressed ? "p" : "r");
                        while (takes.length > 1 && pick === last[id]) pick = Math.floor(Math.random() * takes.length);
                        last[id] = pick;
                        const source = ctx.createBufferSource();
                        source.buffer = takes[pick];
                        source.playbackRate.value = 1 + (Math.random() * 2 - 1) * KEY_PITCH;
                        const level = ctx.createGain();
                        level.gain.value = gain((Math.random() * 2 - 1) * KEY_JITTER_DB + leanDb + KEY_CENTRE_DB);
                        source.connect(level);
                        level.connect(panner);
                        source.onended = () => level.disconnect();
                        source.start();
                    }
                };
            })();

            function createRoom() {
                if (typeof THREE === "undefined") {
                    throw new Error("three.js unavailable");
                }

                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 40);
                const palette = roomPalette();
                scene.background = palette.bg;

                // Above 2x device pixels the backing store is already doing the job MSAA
                // would; paying for both is most of why phones struggled.
                const denseScreen = (window.devicePixelRatio || 1) >= 2;
                const renderer = new THREE.WebGLRenderer({
                    canvas: glCanvas,
                    antialias: !denseScreen,
                    alpha: false,
                    stencil: false,
                    powerPreference: "high-performance"
                });
                renderer.setClearColor(palette.bg, 1);
                maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
                glCanvas.style.position = "absolute";
                glCanvas.style.inset = "0";
                glCanvas.style.pointerEvents = "none";

                const mats = makeMats(palette);
                // Where there is multisampling, the lines' edges are antialiased by coverage.
                mats.lineList.forEach((m) => { m.alphaToCoverage = !denseScreen; });
                const art = makeArt(mats);
                const monitorArt = makeArt(mats);
                const cm = (n) => n / 100;

                // The game's first room: 6 m square, 3 m high, the desk against the back
                // wall, the door behind the chair, the bookcase on the left.
                const HALF = 3;
                const HEIGHT = 3;
                art.edges(new THREE.BoxGeometry(HALF * 2, HEIGHT, HALF * 2), place(0, HEIGHT / 2, 0));

                // Skirting boards round the walls, as the game's room has them: 7.5 cm high.
                const skirtH = 0.075;
                const skirtT = 0.012;
                art.box(HALF * 2, skirtH, skirtT, place(0, skirtH / 2, -HALF + skirtT / 2));
                art.box(HALF * 2, skirtH, skirtT, place(0, skirtH / 2, HALF - skirtT / 2));
                art.box(skirtT, skirtH, HALF * 2, place(-HALF + skirtT / 2, skirtH / 2, 0));
                art.box(skirtT, skirtH, HALF * 2, place(HALF - skirtT / 2, skirtH / 2, 0));

                // -- desk, monitor, keyboard ----------------------------------------------
                const deskY = 0.74;
                // The game's desk: 70 cm deep and PHI squared times that wide (1.83 m).
                const deskD = 0.70;
                const deskHalf = (deskD * PHI * PHI) / 2;
                const deskZ = -HALF + deskD / 2;
                const topT = 0.042;
                const deskTop = deskY + topT / 2;
                art.box(deskHalf * 2, topT, deskD, place(0, deskY, deskZ));
                const legX = deskHalf - 0.08;
                const legZBack = deskZ - deskD / 2 + 0.08;
                const legZFront = deskZ + deskD / 2 - 0.08;
                [[-legX, legZBack], [legX, legZBack], [-legX, legZFront], [legX, legZFront]].forEach(([lx, lz]) => {
                    art.box(0.045, deskY - topT / 2, 0.045, place(lx, (deskY - topT / 2) / 2, lz));
                });
                art.box(deskHalf * 2 - 0.16, 0.028, 0.028, place(0, 0.09, legZBack));
                art.box(deskHalf * 2 - 0.16, 0.028, 0.028, place(0, 0.09, legZFront));
                art.box(deskHalf * 2 - 0.30, 0.32, 0.024, place(0, deskY - 0.28, deskZ - deskD / 2 + 0.07));

                // screenW/screenH/screenY/frontZ define the page's plane, so they stay put.
                const screenW = 0.80;
                const screenH = 0.45;
                const bezel = 0.016;
                const screenY = deskY + 0.44;
                const frontZ = deskZ - 0.07;
                const outerW = screenW + bezel * 2;
                const outerH = screenH + bezel * 2;

                // A flat panel on a stand, as the game's (scaled up from its 60 cm): the panel, a
                // housing behind it that steps in by PHI twice, a riser up to the middle of the
                // screen, and a flat base. The black hole swallows it whole, so its parts live in
                // their own meshes instead of the room's.
                const scale = outerW / 0.6;
                const panelT = 0.016;
                monitorArt.box(outerW, outerH, panelT, place(0, screenY, frontZ - panelT / 2));
                const rear = frontZ - panelT - 0.045;
                const rect = (w, h, z) => [
                    [-w / 2, screenY - h / 2, z], [w / 2, screenY - h / 2, z], [w / 2, screenY + h / 2, z], [-w / 2, screenY + h / 2, z]
                ];
                const housing = loftData(rect(outerW / PHI, outerH / PHI, frontZ - panelT),
                    rect(outerW / PHI / PHI, outerH / PHI / PHI, rear), new THREE.Matrix4());
                monitorArt.raw(housing.faces, housing.edges);
                const baseT = 0.012 * scale;
                const riserH = screenY - (deskTop + baseT);
                monitorArt.box(0.07 * scale, riserH, 0.04, place(0, deskTop + baseT + riserH / 2, rear - 0.02));
                monitorArt.box(0.24 * scale, baseT, 0.192 * scale, place(0, deskTop + baseT / 2, frontZ - 0.05));
                const glassZ = frontZ + 0.003;
                monitorArt.line([
                    [-screenW / 2, screenY - screenH / 2, glassZ], [screenW / 2, screenY - screenH / 2, glassZ],
                    [screenW / 2, screenY + screenH / 2, glassZ], [-screenW / 2, screenY + screenH / 2, glassZ]
                ], false, true);

                // The keyboard, tilted a little, its case in the room's static art and its keys
                // their own meshes (see makeKeyboard).
                const kbZ = deskZ + 0.215;
                const keyboard = makeKeyboard(mats, place(0, deskTop, kbZ, 0, -0.05), palette);
                art.raw(keyboard.frame.faces, keyboard.frame.edges);
                keyboard.meshes.forEach((object) => scene.add(object));
                const keyboardAt = new THREE.Vector3(0, deskTop + 0.03, kbZ);

                // The computer: a tower on the floor right of the desk, its front level with the
                // desk's, a power button and the light that says it is on, and the three cables
                // (the monitor's) coming down behind the desk's end and along the floor.
                const caseW = 0.45 / PHI / PHI;
                const caseH = 0.45;
                const caseX0 = deskHalf + 0.05;
                const caseX = caseX0 + caseW / 2;
                const caseFront = deskZ + deskD / 2;
                const caseZ = caseFront - caseH / 2;
                art.box(caseW, caseH, caseH, place(caseX, caseH / 2, caseZ));
                art.solid(new THREE.CylinderGeometry(0.012, 0.012, 0.006, 16).rotateX(Math.PI / 2),
                    place(caseX, caseH - 0.05, caseFront + 0.003));
                art.accentBox(0.018, 0.004, 0.004, place(caseX, caseH - 0.085, caseFront + 0.002));
                art.line([
                    [caseX - caseW / 2 + 0.02, 0.30, caseFront], [caseX + caseW / 2 - 0.02, 0.30, caseFront],
                    [caseX + caseW / 2 - 0.02, 0.27, caseFront], [caseX - caseW / 2 + 0.02, 0.27, caseFront]
                ], false, true);
                const backZ = deskZ - deskD / 2;
                {
                    const dz = backZ + 0.03;
                    const dx = deskHalf + 0.004;
                    art.line([
                        [0, deskTop + 0.004, frontZ - 0.1], [0, deskTop + 0.004, dz], [dx, deskTop + 0.004, dz],
                        [dx, 0.30, dz], [caseX0, 0.30, caseZ - caseH / 2 + 0.05]
                    ]);
                }

                // Tea: an open drum with a tea-bag string over the rim and its tag hanging down
                // the front, a handle drawn as two curves, and the level of the tea inside.
                // (The string and tag are the game's.)
                const mx = 0.40;
                const mz = deskZ + 0.20;
                const mugH = 0.098;
                art.solid(new THREE.CylinderGeometry(0.042, 0.042, mugH, 24, 1, true), place(mx, deskTop + mugH / 2, mz));
                art.line(ring(mx, deskTop + mugH, mz, 0.036, 24), false, true);
                art.line(ring(mx, deskTop + mugH - 0.022, mz, 0.036, 24), false, true);
                const mug = (dx, h, dz) => [mx + dx / 100, deskTop + h / 100, mz + dz / 100];
                art.line([mug(4.2, 2, 0), mug(6.9, 3, 0), mug(6.9, 7.8, 0), mug(4.2, 8.3, 0)]);
                art.line([mug(4.2, 3.2, 0), mug(5.7, 3.8, 0), mug(5.7, 7.1, 0), mug(4.2, 7.3, 0)]);
                art.line([mug(-1.6, 7.5, 2.6), mug(-2.1, 10, 3.7), mug(-2.3, 9.6, 4.3), mug(-2.5, 6.5, 4.7), mug(-2.6, 5.4, 4.8)]);
                art.line([mug(-3.9, 5.4, 4.85), mug(-1.3, 5.4, 4.85), mug(-1.3, 2.4, 4.85), mug(-3.9, 2.4, 4.85)], false, true);

                // -- the room ---------------------------------------------------------------
                // A rug, the room's side over PHI twice, with a border.
                const rugHalf = (HALF * 2) / PHI / PHI / 2;
                [0, 0.07].forEach((k) => {
                    art.line([
                        [-rugHalf + k, 0.004, -rugHalf + k], [rugHalf - k, 0.004, -rugHalf + k],
                        [rugHalf - k, 0.004, rugHalf - k], [-rugHalf + k, 0.004, rugHalf - k]
                    ], false, true);
                });

                // The light hanging from the ceiling on its cord.
                art.solid(new THREE.CylinderGeometry(0.06, 0.06, 0.025, 20, 1, true), place(0, HEIGHT - 0.0125, 0));
                art.line([[0, HEIGHT - 0.025, 0], [0, 2.50, 0]]);
                art.solid(new THREE.CylinderGeometry(0.03, 0.17, 0.20, 24, 1, true), place(0, 2.40, 0));

                // The door in the back wall, straight behind the chair: its frame standing out
                // of the wall, two panels, and the handle.
                const doorZ = HALF;
                const d = 0.53;
                const df = 0.63;
                art.box(df - d, 2.16, 0.015, place(-(d + df) / 2, 1.08, doorZ - 0.0075));
                art.box(df - d, 2.16, 0.015, place((d + df) / 2, 1.08, doorZ - 0.0075));
                art.box(df * 2, 0.06, 0.015, place(0, 2.13, doorZ - 0.0075));
                [[0.25, 0.95], [1.12, 1.92]].forEach(([y0, y1]) => {
                    art.line([[-d + 0.13, y0, doorZ], [d - 0.13, y0, doorZ], [d - 0.13, y1, doorZ], [-d + 0.13, y1, doorZ]], false, true);
                });
                art.box(0.04, 0.08, 0.01, place(-0.32, 1.04, doorZ - 0.005));
                art.box(0.013, 0.014, 0.036, place(-0.32, 1.04, doorZ - 0.028));
                art.box(0.116, 0.014, 0.014, place(-0.266, 1.04, doorZ - 0.053));
                // Whatever is on the other side shows as a sliver under it.
                art.line([[-d + 0.03, 0.006, doorZ - 0.02], [d - 0.03, 0.006, doorZ - 0.02]], true);

                // The bookcase, against the left wall, in the middle of it: boards, then every
                // shelf full of books, and on every other shelf a few lying in a stack at the end.
                // Seeded, so it is the same case every visit. Sizes in cm, as the game has them.
                const BH = 240;
                const bz0 = -BH / PHI / 2;
                const bz1 = BH / PHI / 2;
                const bx0 = -HALF * 100;
                const bx1 = bx0 + 34;
                const boards = [
                    [bx0, bx1, 0, BH, bz0, bz0 + 2], [bx0, bx1, 0, BH, bz1 - 2, bz1], [bx0, bx1, BH - 2, BH, bz0 + 2, bz1 - 2],
                    [bx0, bx1, 0, 6, bz0 + 2, bz1 - 2], [bx0, bx0 + 1, 6, BH - 2, bz0 + 2, bz1 - 2]
                ];
                let seed = 1618;
                const rand = (a, b) => {
                    seed = (seed * 1664525 + 1013904223) >>> 0;
                    return a + ((b - a) * seed) / 4294967296;
                };
                const shelf = (BH - 2 - 6 - 2 * 5) / 6;
                for (let k = 0; k < 6; k++) {
                    const y0 = 6 + k * (shelf + 2);
                    const lying = k % 2 === 1;
                    if (k > 0) boards.push([bx0 + 1, bx1, y0 - 2, y0, bz0 + 2, bz1 - 2]);
                    const end = bz1 - 2.5 - (lying ? 24 : 0);
                    for (let z = bz0 + 2.5; ;) {
                        const w = rand(2.2, 5.5);
                        if (z + w > end) break;
                        boards.push([bx1 - 3 - rand(19, 26), bx1 - 3, y0, y0 + shelf * rand(0.62, 0.9), z, z + w]);
                        z += w + 0.25;
                    }
                    if (lying) {
                        let y = y0;
                        for (let i = 0, n = Math.round(rand(4, 6)); i < n; i++) {
                            const thick = rand(2.5, 4.5);
                            const long = rand(17, 22);
                            boards.push([bx1 - 3 - rand(18, 24), bx1 - 3, y, y + thick, end + 1, end + 1 + long]);
                            y += thick;
                        }
                    }
                }
                boards.forEach((b) => {
                    art.box(cm(b[1] - b[0]), cm(b[3] - b[2]), cm(b[5] - b[4]),
                        place(cm(b[0] + b[1]) / 2, cm(b[2] + b[3]) / 2, cm(b[4] + b[5]) / 2));
                });

                // The picture over the monitor: a frame PHI times as wide as high, centred where
                // the wall's height divides by PHI, with an eye in it (a vesica piscis, where two
                // circles each through the other's centre overlap). The eyeball is a sphere that
                // turns to watch you, its iris and pupil in the accent colour.
                const wall = -HALF;
                const ph = HEIGHT / PHI;
                const fw = (HALF * 2) / Math.pow(PHI, 4) / 2;
                const fh = fw / PHI;
                const inset = fw * 0.135;
                const face = wall + 0.025;
                const er = fw * 0.584;
                const yb = ph - fh;
                const yt = ph + fh;
                const frame = loftData(
                    [[-fw, yb, wall], [fw, yb, wall], [fw, yt, wall], [-fw, yt, wall]],
                    [[-fw, yb, face], [fw, yb, face], [fw, yt, face], [-fw, yt, face]],
                    new THREE.Matrix4(), true);
                art.raw(frame.faces, frame.edges);
                art.line([
                    [-fw + inset, ph - fh + inset, face], [fw - inset, ph - fh + inset, face],
                    [fw - inset, ph + fh - inset, face], [-fw + inset, ph + fh - inset, face]
                ], false, true);
                const upper = [];
                const lower = [];
                for (let i = 0; i <= 24; i++) {
                    const t = ((150 - (120 * i) / 24) * Math.PI) / 180;
                    upper.push([er * Math.cos(t), ph - er / 2 + er * Math.sin(t)]);
                    lower.push([er * Math.cos(t), ph + er / 2 - er * Math.sin(t)]);
                }
                // The face is cut through by the opening between the lids, so the eyeball, turning
                // behind it, stays in view instead of going behind a solid face.
                const lids = new THREE.Path();
                lids.moveTo(upper[0][0], upper[0][1]);
                upper.forEach((p) => lids.lineTo(p[0], p[1]));
                for (let i = lower.length - 1; i >= 0; i--) lids.lineTo(lower[i][0], lower[i][1]);
                const facePlate = new THREE.Shape([
                    new THREE.Vector2(-fw, yb), new THREE.Vector2(fw, yb), new THREE.Vector2(fw, yt), new THREE.Vector2(-fw, yt)
                ]);
                facePlate.holes.push(lids);
                art.solid(new THREE.ShapeGeometry(facePlate), place(0, 0, face));
                const eyeA = er * Math.cos((30 * Math.PI) / 180);
                const ball = eyeA * 0.5;
                const eyeAt = new THREE.Vector3(0, ph, face - 0.25 * ball);
                art.faces(new THREE.SphereGeometry(ball, 14, 10), place(eyeAt.x, eyeAt.y, eyeAt.z));
                const eye = new THREE.Group();
                eye.position.copy(eyeAt);
                eye.rotation.order = "YXZ";
                [eyeA * 0.38, eyeA * 0.16].forEach((r, i) => {
                    const a = Math.asin(r / ball);
                    const rim = [];
                    for (let k = 0; k < 40; k++) {
                        const t = (Math.PI * 2 * k) / 40;
                        rim.push(new THREE.Vector3(Math.sin(a) * Math.cos(t), Math.sin(a) * Math.sin(t), Math.cos(a)).multiplyScalar(ball + 0.0015));
                    }
                    eye.add(fatLines(runSegments(rim.map((q) => [q.x, q.y, q.z]), true), mats.accentLine));
                    if (i === 1) {
                        const fan = [];
                        rim.forEach((p, k) => fan.push(new THREE.Vector3(0, 0, ball + 0.002), p, rim[(k + 1) % rim.length]));
                        eye.add(new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(fan), mats.accentFace));
                    }
                });
                scene.add(eye);

                // The wall clock over the picture, keeping the visitor's own time: a round case
                // standing out of the wall, a tick at every hour (the quarters longer), and three
                // hands, the second's in the accent colour.
                const clockR = 0.2;
                const clockAt = new THREE.Vector3(0, 2.58, wall);
                const clockFace = wall + 0.04;
                art.solid(new THREE.CylinderGeometry(clockR, clockR, 0.04, 48, 1, true).rotateX(Math.PI / 2),
                    place(clockAt.x, clockAt.y, wall + 0.02));
                const bezelRing = [];
                for (let i = 0; i < 48; i++) {
                    const t = (Math.PI * 2 * i) / 48;
                    bezelRing.push([clockR * 0.92 * Math.cos(t), clockAt.y + clockR * 0.92 * Math.sin(t), clockFace]);
                }
                art.line(bezelRing, false, true);
                for (let i = 0; i < 12; i++) {
                    const sx = Math.sin((Math.PI * 2 * i) / 12);
                    const cy = Math.cos((Math.PI * 2 * i) / 12);
                    const long = i % 3 === 0 ? 0.16 : 0.08;
                    art.line([
                        [sx * clockR * 0.84, clockAt.y + cy * clockR * 0.84, clockFace],
                        [sx * clockR * (0.84 - long), clockAt.y + cy * clockR * (0.84 - long), clockFace]
                    ]);
                }
                const hands = {};
                [["hour", 0.5, 0.06, 0.12], ["minute", 0.76, 0.045, 0.14], ["second", 0.84, 0, 0.22]].forEach(([name, length, half, tail], i) => {
                    const hand = new THREE.Group();
                    hand.position.set(clockAt.x, clockAt.y, clockFace + 0.004 * (i + 1));
                    const tip = [0, length * clockR];
                    const back = [0, -tail * clockR];
                    if (half === 0) {
                        hand.add(fatLines(runSegments([[back[0], back[1], 0], [tip[0], tip[1], 0]]), mats.accentLine));
                    } else {
                        const outline = [back, [half * clockR, 0], tip, [-half * clockR, 0]]
                            .map((p) => new THREE.Vector2(p[0], p[1]));
                        hand.add(new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(outline)), mats.face));
                        hand.add(fatLines(runSegments(outline.map((q) => [q.x, q.y, 0]), true), mats.line));
                    }
                    hands[name] = hand;
                    scene.add(hand);
                });
                const pin = [];
                for (let i = 0; i < 12; i++) {
                    const t = (Math.PI * 2 * i) / 12;
                    pin.push([clockR * 0.035 * Math.cos(t), clockAt.y + clockR * 0.035 * Math.sin(t), clockFace + 0.016]);
                }
                art.line(pin, true, true);

                const roomMeshes = art.build(scene);
                const monitorProxy = monitorArt.build(scene);

                // The round things, whose sides have no crease to draw: a line down each edge as
                // seen from where the camera is. [x, z, y0, y1, r0, r1] for an upright frustum.
                const upright = [
                    [mx, mz, deskTop, deskTop + mugH, 0.042, 0.042],
                    [0, 0, 2.30, 2.50, 0.17, 0.03]
                ];
                const sideData = new Float32Array(upright.length * 12);
                const sides = fatLines(sideData, mats.line);
                sides.frustumCulled = false;
                scene.add(sides);

                function update() {
                    const cam = camera.position;
                    const p = sideData;
                    upright.forEach((s, i) => {
                        const dx = s[0] - cam.x;
                        const dz = s[1] - cam.z;
                        const len = Math.hypot(dx, dz) || 1;
                        const px = -dz / len;
                        const pz = dx / len;
                        [1, -1].forEach((sign, k) => {
                            const o = i * 12 + k * 6;
                            p[o] = s[0] + px * s[4] * sign; p[o + 1] = s[2]; p[o + 2] = s[1] + pz * s[4] * sign;
                            p[o + 3] = s[0] + px * s[5] * sign; p[o + 4] = s[3]; p[o + 5] = s[1] + pz * s[5] * sign;
                        });
                    });
                    sides.geometry.attributes.instanceStart.data.needsUpdate = true;

                    // The eye turns to look straight at the camera, as far as the lids let it.
                    const to = tmpEye.copy(cam).sub(eye.position);
                    eye.rotation.set(
                        -Math.max(-0.6, Math.min(0.6, Math.atan2(to.y, Math.hypot(to.x, to.z)))),
                        Math.max(-0.9, Math.min(0.9, Math.atan2(to.x, to.z))), 0);

                    // The clock tells the visitor's time, the second hand stepping as quartz does.
                    const now = new Date();
                    const s = now.getSeconds();
                    const m = now.getMinutes() + s / 60;
                    const h = (now.getHours() % 12) + m / 60;
                    hands.second.rotation.z = (-s / 60) * Math.PI * 2;
                    hands.minute.rotation.z = (-m / 60) * Math.PI * 2;
                    hands.hour.rotation.z = (-h / 12) * Math.PI * 2;
                }

                const screenGlass = new THREE.Mesh(
                    new THREE.PlaneGeometry(1, 1),
                    new THREE.MeshBasicMaterial({
                        color: palette.bg,
                        depthWrite: true,
                        depthTest: true
                    })
                );
                screenGlass.renderOrder = 10;
                screenGlass.position.set(0, screenY, frontZ + 0.002);
                screenGlass.scale.set(screenW, screenH, 1);
                scene.add(screenGlass);
                const screenZ = frontZ + 0.002;

                const chairZ = deskZ + 0.72;
                const chairX = 0;
                const chairRotY = Math.PI;

                overlay.classList.add("monitor-html");

                // The page on the monitor is the real .app element, put on the screen by a CSS matrix
                // made from the camera's own projection (see syncMonitorPage), so it lands exactly
                // where the 3D screen is, lens shift and all, and one element serves every view.
                const cssLayer = document.createElement("div");
                cssLayer.id = "room-css";
                cssLayer.style.pointerEvents = "none";
                const hudEl = document.getElementById("room-hud");
                layer.insertBefore(cssLayer, hudEl);
                overlay.style.position = "absolute";
                overlay.style.left = "0";
                overlay.style.top = "0";
                overlay.style.transformOrigin = "0 0";
                overlay.style.willChange = "transform";
                cssLayer.appendChild(overlay);

                function resize() {
                    const w = layer.clientWidth || window.innerWidth;
                    const h = layer.clientHeight || window.innerHeight;
                    camera.aspect = w / Math.max(h, 1);
                    camera.updateProjectionMatrix();
                    // The 2D site renders text at the device's native density; capping the
                    // room below that is exactly what made it look softer than the rest of
                    // the page. 3 is the ceiling only so 4x tablets do not melt.
                    renderer.setPixelRatio(targetPixelRatio());
                    // A canvas is a replaced element: "inset: 0" cannot stretch it, so with
                    // width:auto it lays out at its backing-store size. Skipping the style
                    // update was fine while the pixel ratio was 1, but at 3 it displayed
                    // three times oversized. Let three set the CSS size in CSS pixels.
                    renderer.setSize(w, h);
                    // Line widths are in CSS pixels of the view.
                    mats.lineList.forEach((m) => m.resolution.set(w, h));
                }

                const roomState = {
                    scene,
                    camera,
                    renderer,
                    cssLayer,
                    mount: overlay,
                    appHome: null,
                    htmlSurface: HTML_CANVAS_SUPPORTED
                        ? createHtmlSurface(STAGE_W, STAGE_H)
                        : createBakeSurface(SCREEN_CSS_W, SCREEN_CSS_H),
                    screenMode: "dom",
                    mats,
                    palette,
                    screenGlass,
                    screenMesh: null,
                    monitorProxy,
                    roomMeshes,
                    clockAt,
                    update,
                    keyboard,
                    keyboardAt,
                    deskY,
                    deskZ,
                    chairX,
                    chairZ,
                    chairRotY,
                    screen: { x: 0, y: screenY, z: screenZ, w: screenW, h: screenH },
                    // What the body cannot walk through: footprints on the floor.
                    obstacles: [
                        { minX: -deskHalf - 0.02, maxX: deskHalf + 0.02,
                          minZ: deskZ - deskD / 2, maxZ: deskZ + deskD / 2 },
                        { minX: chairX - 0.16, maxX: chairX + 0.16,
                          minZ: chairZ - 0.18, maxZ: chairZ + 0.20 },
                        { minX: caseX0, maxX: caseX0 + caseW,
                          minZ: caseFront - caseH, maxZ: caseFront },
                        { minX: cm(bx0), maxX: cm(bx1), minZ: cm(bz0), maxZ: cm(bz1) }
                    ],
                    HALF,
                    resize
                };
                roomState.propsReady = Promise.all([
                    loadPropModel(roomState, CHAIR_MODEL_URLS, installChairModel)
                ]);
                return roomState;
            }

            // Captures .app into a texture. The staging <canvas layoutsubtree> hosts the
            // element and drawElementImage paints it; three's CanvasTexture upload stalls
            // when handed a layoutsubtree canvas directly (it never sees the repaint as a
            // content change), so pixels are copied into a plain mirror canvas first and
            // that is what the texture reads.
            function createHtmlSurface(width, height) {
                const holder = document.createElement("div");
                holder.className = "hic-stage";
                const stage = document.createElement("canvas");
                stage.setAttribute("layoutsubtree", "");
                stage.width = width;
                stage.height = height;
                holder.appendChild(stage);
                document.body.appendChild(holder);

                const stageCtx = stage.getContext("2d");
                const mirror = document.createElement("canvas");
                mirror.width = width;
                mirror.height = height;
                const mirrorCtx = mirror.getContext("2d");

                const texture = new THREE.CanvasTexture(mirror);
                // The panel is far smaller on screen than the capture, so this is always a
                // minification: mipmaps plus anisotropy are what keep the text from
                // shimmering into mush at a glancing angle.
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.generateMipmaps = true;
                texture.anisotropy = maxAnisotropy;

                let dirty = false;
                stage.onpaint = function () {
                    const app = stage.querySelector(".app");
                    if (!app) return;
                    // drawElementImage preserves alpha, and the screen material samples RGB
                    // only -- so a translucent white like --term-shadow would land as solid
                    // white. Compositing over the theme background first is what the page
                    // itself does, and keeps the capture faithful.
                    stageCtx.setTransform(1, 0, 0, 1, 0, 0);
                    stageCtx.clearRect(0, 0, stage.width, stage.height);
                    stageCtx.fillStyle = getComputedStyle(document.documentElement)
                        .getPropertyValue("--bg").trim() || "#000";
                    stageCtx.fillRect(0, 0, stage.width, stage.height);
                    // The element's layout size follows the viewport, so derive the
                    // supersample factor from it rather than assuming a fixed width.
                    const scale = app.offsetWidth ? stage.width / app.offsetWidth : 1;
                    stageCtx.setTransform(scale, 0, 0, scale, 0, 0);
                    stageCtx.drawElementImage(app, 0, 0);
                    dirty = true;
                    // onpaint lands a frame or more after requestPaint, so the render loop
                    // has to be woken again or a static scene would keep the stale texture.
                    markRender();
                };

                return {
                    texture: texture,
                    holds(app) {
                        return !!app && stage.contains(app);
                    },
                    adopt(app) {
                        if (app && !stage.contains(app)) stage.appendChild(app);
                        this.repaint();
                    },
                    repaint() {
                        if (typeof stage.requestPaint === "function") stage.requestPaint();
                    },
                    sync() {
                        if (!dirty) return;
                        dirty = false;
                        mirrorCtx.clearRect(0, 0, mirror.width, mirror.height);
                        mirrorCtx.drawImage(stage, 0, 0);
                        texture.needsUpdate = true;
                    },
                    dispose() {
                        stage.onpaint = null;
                        texture.dispose();
                        holder.remove();
                    }
                };
            }

            // Fallback when drawElementImage is missing (every normal browser, including
            // phones): the black hole bakes .app into a texture once, through an SVG, so the
            // lens has a picture to bend.
            function createBakeSurface(width, height) {
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                const texture = new THREE.CanvasTexture(canvas);
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.generateMipmaps = true;
                texture.anisotropy = maxAnisotropy;

                let appRef = null;
                let dirty = false;
                let baking = false;
                let rebake = false;
                let bakeGen = 0;

                // The page's styles as text for the SVG: every sheet the document has (style.css
                // is a linked file, so there is no <style> block to read), the room's body class
                // swapped for the bake's, and the latin faces of the page's fonts inlined,
                // because an SVG drawn as an image may not fetch anything. Built once.
                let stylesReady = null;

                function pageStyles() {
                    if (stylesReady) return stylesReady;
                    const rules = [];
                    const fonts = [];
                    for (const sheet of document.styleSheets) {
                        let list;
                        try { list = sheet.cssRules; } catch (error) { continue; }
                        for (const rule of list) {
                            if (rule.type !== CSSRule.FONT_FACE_RULE) rules.push(rule.cssText);
                            else if (rule.style.getPropertyValue("unicode-range").includes("U+0000-00FF")) fonts.push(rule);
                        }
                    }
                    stylesReady = Promise.all(fonts.map(async (rule) => {
                        try {
                            const file = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue("src"))[1];
                            const blob = await (await fetch(file)).blob();
                            const data = await new Promise((done) => {
                                const reader = new FileReader();
                                reader.onload = () => done(reader.result);
                                reader.readAsDataURL(blob);
                            });
                            return rule.cssText.replace(/url\([^)]*\)/, 'url("' + data + '")');
                        } catch (error) {
                            return "";
                        }
                    })).then((faces) => faces.concat(rules).join("\n")
                        .replace(/body\.room-active/g, ".room-bake")
                        // The SVG is parsed as XML, where a bare & or < is fatal.
                        .replace(/&/g, "&amp;").replace(/</g, "&lt;"));
                    return stylesReady;
                }

                function bake(app) {
                    if (!app) return;
                    if (baking) {
                        rebake = true;
                        return;
                    }
                    baking = true;
                    const gen = ++bakeGen;
                    pageStyles().then((css) => {
                        if (gen !== bakeGen) {
                            baking = false;
                            return;
                        }
                        draw(app, css, gen);
                    });
                }

                function draw(app, css, gen) {
                    const w = app.offsetWidth || room.htmlW || width;
                    const h = app.offsetHeight || room.htmlH || height;
                    // The picture is made at twice the page's size (the SVG is vector, so the text
                    // is drawn at that size, not scaled up), so the mipmaps the GPU takes it down
                    // from are sharper; capped for the sake of small GPUs.
                    const scale = Math.min(2, 2048 / w);
                    const cw = Math.round(w * scale);
                    if (canvas.width !== cw) {
                        canvas.width = cw;
                        canvas.height = Math.round(h * scale);
                    }
                    const theme = document.documentElement.dataset.theme || "modus-vivendi";
                    const bg = getComputedStyle(document.documentElement)
                        .getPropertyValue("--bg").trim() || "#000";
                    const markup = new XMLSerializer().serializeToString(app);
                    const svg = [
                        '<svg xmlns="http://www.w3.org/2000/svg" width="', w, '" height="', h, '">',
                        '<foreignObject width="100%" height="100%">',
                        '<div xmlns="http://www.w3.org/1999/xhtml" class="room-bake" data-theme="', theme, '"',
                        ' style="width:', w, 'px;height:', h, 'px;background:', bg, ';overflow:hidden">',
                        '<style>',
                        css,
                        // Two things the foreignObject cannot inherit from the real page.
                        // 1. html/body rules do not apply here -- there is no html or body
                        //    inside the SVG -- so the base type has to be restated or the
                        //    whole page renders in the browser default serif.
                        // 2. Static SVG never runs animations, so .content-section is
                        //    frozen on fadein's first frame at opacity 0 and the entire
                        //    section body renders blank.
                        '.room-bake{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,',
                        'Menlo,Consolas,monospace;font-size:15px;line-height:1.55;',
                        // Without this everything that merely inherits its colour renders
                        // black on black -- only the rules naming a colour survived.
                        'color:var(--fg)}',
                        '.room-bake *,.room-bake *::before,.room-bake *::after',
                        '{animation:none !important;transition:none !important}',
                        '</style>',
                        markup,
                        '</div></foreignObject></svg>'
                    ].join("");

                    const img = new Image();
                    img.decoding = "async";
                    const done = () => {
                        baking = false;
                        if (rebake) {
                            rebake = false;
                            bake(appRef);
                        }
                    };
                    img.onload = function () {
                        if (gen !== bakeGen) {
                            done();
                            return;
                        }
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.fillStyle = bg;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        dirty = true;
                        done();
                        markRender();
                    };
                    img.onerror = function () {
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.fillStyle = bg;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        dirty = true;
                        done();
                        markRender();
                    };
                    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
                }

                return {
                    texture: texture,
                    holds(app) {
                        return !!app && appRef === app;
                    },
                    adopt(app) {
                        appRef = app || null;
                        bake(appRef);
                    },
                    repaint() {
                        // One shot per adopt / theme change -- re-baking every frame is too
                        // expensive on a phone and the page does not change while looking.
                    },
                    sync() {
                        if (!dirty) return;
                        dirty = false;
                        texture.needsUpdate = true;
                    },
                    dispose() {
                        bakeGen += 1;
                        texture.dispose();
                        appRef = null;
                    }
                };
            }

            function loadPropModel(roomState, urls, install) {
                return (async () => {
                    for (const url of urls) {
                        try {
                            const gltf = await loadGltf(url);
                            install(roomState, gltf.scene);
                            return;
                        } catch (error) {
                            console.warn("room: could not load " + url, error);
                        }
                    }
                })();
            }

            function standUpright(model) {
                model.updateMatrixWorld(true);
                const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
                if (size.z >= size.y && size.z >= size.x) model.rotation.x = -Math.PI / 2;
                else if (size.x >= size.y && size.x >= size.z) model.rotation.z = Math.PI / 2;
            }

            function installChairModel(roomState, model) {
                model.rotation.set(0, 0, 0);
                standUpright(model);
                model.rotateY(roomState.chairRotY);
                model.updateMatrixWorld(true);
                const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
                model.scale.multiplyScalar(0.92 / Math.max(size.y, 0.001));
                model.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(model);
                const center = box.getCenter(new THREE.Vector3());
                model.position.x += roomState.chairX - center.x;
                model.position.y += -box.min.y;
                model.position.z += roomState.chairZ - center.z;
                model.updateMatrixWorld(true);
                const placed = new THREE.Box3().setFromObject(model);
                roomState.obstacles[1] = {
                    minX: placed.min.x + 0.05,
                    maxX: placed.max.x - 0.05,
                    minZ: placed.min.z + 0.05,
                    maxZ: placed.max.z - 0.05
                };
                // Drawn as line art with the rest: its faces hide what is behind it, its creases
                // are inked. The glTF itself is never added to the scene.
                const art = makeArt(roomState.mats);
                model.traverse((node) => {
                    if (node.isMesh) art.solid(node.geometry, node.matrixWorld);
                });
                art.build(roomState.scene);
            }

            const keys = Object.create(null);
            // Keys whose press was sounded, so only their letting go is.
            const heard = Object.create(null);

            // A keyup that lands while the window is blurred (alt-tab, Esc out of the
            // room) never reaches us, which would leave the key stuck down.
            function releaseKeys() {
                for (const code in keys) keys[code] = false;
                if (room) room.keyboard.releaseAll();
            }

            // What the rest of the room reads. x and z are the body on the floor; yaw and
            // pitch where the eyes look on foot (a move takes them from the pose instead).
            const player = {
                x: 0,
                z: 0,
                vx: 0,
                vz: 0,
                yaw: 0,
                pitch: 0,
                locked: false,
                playing: false,
                animating: false,
                sitting: false
            };

            // Touch state, mirrored into the same movement code the keyboard feeds.
            const touch = {
                enabled: false,
                stick: { active: false, x: 0, y: 0, id: -1, baseX: 0, baseY: 0 },
                look: { id: -1, lastX: 0, lastY: 0 }
            };

            const FOV_STAND = 52;
            const FOV_SIT = 46;               // leaned in
            const FOV_BACK = 50;

            // The camera and the walking are the game's (aeos-core game/player.gd), in metres:
            // Quake's acceleration and friction on a fixed 120 Hz tick with the eye put
            // between the last two ticks, so it never steps whatever the frame rate; a bob
            // by how fast the body goes, a lean into a step to the side, and a slow sway
            // standing. Every other move takes each channel of the pose from where it is, at
            // the speed it is going, to where it goes, on a quintic: it starts and stops
            // without a jolt and can be turned round halfway.
            const EYE = 1.65;                // the eye's height standing
            const RADIUS = 0.22;             // the body, seen from above
            const SPEED = 1.4;               // walking pace, metres a second
            const ACCELERATE = 10;           // Quake's sv_accelerate
            const FRICTION = 6;              // and sv_friction,
            const STOP = 0.6;                // under which friction stops at a steady rate
            const TICK = 1 / 120;
            const STEP = 0.7;                // a step's length, for the bob
            const BOB_UP = 0.009;
            const BOB_SIDE = 0.006;
            const STRAFE_ROLL = 0.012;       // radians, at full speed sideways
            // Mouse look: Half-Life 2's sensitivity 3 (0.066 degrees a count), raw.
            const LOOK_SCALE = 0.066 * Math.PI / 180;
            const PITCH_LIMIT = 85 * Math.PI / 180;
            const TOUCH_LOOK_SCALE = 0.0038;          // rad per css px, tuned for thumbs
            // The places, back to front in the chair, and a pose's channels.
            const STAND = 0;
            const BACK = 1;                  // leaned back, the monitor and the desk in view
            const CLOSE = 2;                 // leaned in, the screen fills the view
            // SHIFT is the lens shift: how far up the view's middle the screen sits, as a share of
            // the view's height (the game's shift lens), so the eye can look level, square to the
            // screen, and still see the keyboard under it.
            const X = 0, Y = 1, Z = 2, YAW = 3, PITCH = 4, ROLL = 5, FOV = 6, SWAY = 7, SHIFT = 8;

            // How long each move takes, for the body across (and how wide the eye sees), the
            // body up or down, the eyes (where they look, and the roll) and the sway; and
            // [channel, how far, from, to] for the bumps on the way: sinking into the chair
            // and settling, a nod, a lean into the turn.
            const MOVES = {
                intro: { time: [4.8, 4.8, 4.8, 4.8], bumps: [] },
                sit: {
                    time: [3.6, 4.4, 3.0, 4.4],
                    bumps: [[Y, -0.025, 0.55, 1.0], [PITCH, -0.025, 0.62, 1.0], [ROLL, 0.022, 0.1, 0.7]]
                },
                stand: { time: [2.6, 1.8, 2.0, 1.2], bumps: [[Y, 0.01, 0.5, 1.0]] },
                lean: { time: [1.5, 1.5, 1.1, 1.5], bumps: [[Y, -0.006, 0.5, 1.0]] },
                "sit up": { time: [1.1, 1.1, 0.8, 0.9], bumps: [] }
            };

            let posture = STAND;
            let walking = false;             // on foot: false in a move, or in the chair
            let approach = false;            // walking up to the chair to sit, on its own steps
            let approachTime = 0;
            let pose = [0, EYE, 0, 0, 0, 0, FOV_STAND, 0, 0];
            let prevPose = pose.slice();
            let prevDt = 0;
            let move = null;
            let clock = 0;
            // The body at the last two ticks, time not yet ticked, how far it has walked, and
            // how much it bobs.
            const body = { lastX: 0, lastZ: 0, ticks: 0, stride: 0, walkedX: 0, walkedZ: 0, bob: 0 };
            const mouse = { x: 0, y: 0 };

            // Scratch vectors: these run on every frame, so they are reused rather than
            // reallocated.
            const tmpChair = new THREE.Vector3();
            const tmpToChair = new THREE.Vector3();
            const tmpForward = new THREE.Vector3();
            const tmpToCam = new THREE.Vector3();
            const tmpNormal = new THREE.Vector3();
            const lensCenter = new THREE.Vector3();

            function wrapAngle(a) {
                return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
            }

            // Quake's PM_Friction: slows by a share of the speed, or of STOP when slower
            // than that, so it comes to a stop rather than creeping.
            function applyFriction(dt) {
                const speed = Math.hypot(player.vx, player.vz);
                if (speed < 0.005) {
                    player.vx = 0;
                    player.vz = 0;
                    return;
                }
                const scale = Math.max(speed - Math.max(speed, STOP) * FRICTION * dt, 0) / speed;
                player.vx *= scale;
                player.vz *= scale;
            }

            // PM_Accelerate: towards wishSpeed along the direction, never past it.
            function accelerate(dirX, dirZ, wishSpeed, dt) {
                const add = wishSpeed - (player.vx * dirX + player.vz * dirZ);
                if (add <= 0) return;
                const step = Math.min(ACCELERATE * wishSpeed * dt, add);
                player.vx += dirX * step;
                player.vz += dirZ * step;
            }

            // The body at (x, z) kept out of the room's solids and its walls, sliding along
            // them: what pushed into one is taken off the speed.
            const spot = { x: 0, z: 0 };

            function collide(x, z) {
                room.obstacles.forEach((box) => {
                    const nx = Math.min(Math.max(x, box.minX), box.maxX);
                    const nz = Math.min(Math.max(z, box.minZ), box.maxZ);
                    let ox = x - nx;
                    let oz = z - nz;
                    if (ox * ox + oz * oz >= RADIUS * RADIUS) return;
                    if (ox === 0 && oz === 0) {
                        // Inside it: out by the nearest side.
                        const outs = [
                            [x - box.minX, -1, 0], [box.maxX - x, 1, 0], [z - box.minZ, 0, -1], [box.maxZ - z, 0, 1]
                        ].sort((a, b) => a[0] - b[0]);
                        ox = outs[0][1];
                        oz = outs[0][2];
                        x += ox * outs[0][0];
                        z += oz * outs[0][0];
                    } else {
                        const len = Math.hypot(ox, oz);
                        ox /= len;
                        oz /= len;
                        x = nx + ox * RADIUS;
                        z = nz + oz * RADIUS;
                    }
                    const into = Math.min(0, player.vx * ox + player.vz * oz);
                    player.vx -= ox * into;
                    player.vz -= oz * into;
                });
                const limit = room.HALF - RADIUS;
                const cx = Math.min(Math.max(x, -limit), limit);
                const cz = Math.min(Math.max(z, -limit), limit);
                if (cx !== x) player.vx = 0;
                if (cz !== z) player.vz = 0;
                spot.x = cx;
                spot.z = cz;
                return spot;
            }

            // Which way the keys push: forward and right, each -1 to 1 (the stick's analog).
            function wish() {
                if (touch.stick.active) return [touch.stick.y, touch.stick.x];
                return [
                    ((keys.KeyW || keys.ArrowUp) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown) ? 1 : 0),
                    ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0)
                ];
            }

            function swayOn() {
                return player.locked || touch.enabled;
            }

            // Where the body is between its last two ticks.
            function eyeSpot() {
                const k = body.ticks / TICK;
                return [body.lastX + (player.x - body.lastX) * k, body.lastZ + (player.z - body.lastZ) * k];
            }

            function walk(dt) {
                // The mouse's motion since the last frame, all of it now.
                const mx = mouse.x;
                const my = mouse.y;
                mouse.x = 0;
                mouse.y = 0;
                const target = approach ? standPose() : null;
                if (target) {
                    // Turning to the desk, the mouse aside.
                    const k = 1 - Math.exp(-dt / 0.4);
                    player.yaw += wrapAngle(target[YAW] - player.yaw) * k;
                    player.pitch += (target[PITCH] - player.pitch) * k;
                } else {
                    player.yaw -= mx * LOOK_SCALE;
                    player.pitch -= my * LOOK_SCALE;
                }
                player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, player.pitch));

                const sin = Math.sin(player.yaw);
                const cos = Math.cos(player.yaw);
                let forward = 0;
                let right = 0;
                let pace = 1;
                if (target) {
                    const [ax, az] = eyeSpot();
                    const dx = target[X] - ax;
                    const dz = target[Z] - az;
                    const d = Math.hypot(dx, dz);
                    if (d > 0.02) {
                        forward = (dx * -sin + dz * -cos) / d;
                        right = (dx * cos + dz * -sin) / d;
                        pace = Math.min(Math.max(d / 0.9, 0.3), 0.6);
                    }
                } else {
                    [forward, right] = wish();
                }
                // Forward is (-sin, -cos) on the floor, right (cos, -sin).
                let dirX = -sin * forward + cos * right;
                let dirZ = -cos * forward + -sin * right;
                const len = Math.hypot(dirX, dirZ);
                const full = Math.min(1, len);
                if (len > 0) {
                    dirX /= len;
                    dirZ /= len;
                }
                body.ticks += dt;
                while (body.ticks >= TICK) {
                    body.ticks -= TICK;
                    body.lastX = player.x;
                    body.lastZ = player.z;
                    applyFriction(TICK);
                    if (len > 0) accelerate(dirX, dirZ, SPEED * pace * full, TICK);
                    const moved = collide(player.x + player.vx * TICK, player.z + player.vz * TICK);
                    player.x = moved.x;
                    player.z = moved.z;
                }
                const [ax, az] = eyeSpot();
                body.stride += Math.hypot(ax - body.walkedX, az - body.walkedZ);
                body.walkedX = ax;
                body.walkedZ = az;
                body.bob += (Math.min(Math.hypot(player.vx, player.vz) / SPEED, 1) - body.bob) * (1 - Math.exp(-dt / 0.12));
                if (target) {
                    approachTime += dt;
                    const there = Math.hypot(player.x - target[X], player.z - target[Z]) < 0.06;
                    const facing = Math.abs(wrapAngle(player.yaw - target[YAW])) < 0.12 && Math.abs(player.pitch - target[PITCH]) < 0.12;
                    if ((there && facing) || approachTime > 4) {
                        approach = false;
                        go(BACK, "sit");
                    }
                }
            }

            function walkingPose() {
                const [ax, az] = eyeSpot();
                const phase = (body.stride / STEP) * Math.PI;
                const rx = Math.cos(player.yaw);
                const rz = -Math.sin(player.yaw);
                const side = BOB_SIDE * body.bob * Math.sin(phase);
                const roll = -Math.max(-1, Math.min(1, (player.vx * rx + player.vz * rz) / SPEED)) * STRAFE_ROLL
                    - body.bob * 0.004 * Math.sin(phase);
                return [ax + rx * side, EYE + BOB_UP * body.bob * Math.cos(2 * phase), az + rz * side,
                    player.yaw, player.pitch, roll, FOV_STAND, swayOn() ? 1 : 0, 0];
            }

            // A pose at (x, y, z) looking at the middle of the screen, or at (the screen's x,
            // targetY, targetZ).
            function aimedPose(x, y, z, fov, shift, targetY, targetZ) {
                const dx = room.screen.x - x;
                const dy = (targetY === undefined ? room.screen.y : targetY) - y;
                const dz = (targetZ === undefined ? room.screen.z : targetZ) - z;
                return [x, y, z, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), 0, fov, 0, shift || 0];
            }

            // Behind the chair, facing the desk: where the intro ends, where standing up
            // lands, and where the walk to the chair goes.
            function standPose() {
                const p = aimedPose(room.screen.x, EYE, room.chairZ + 0.62, FOV_STAND);
                p[SWAY] = swayOn() ? 1 : 0;
                return p;
            }

            // A character of the page is 9 CSS pixels across (15 px monospace). Shown at a fraction of
            // its size it is drawn on whole pixels, and so evenly, only if that comes out a whole
            // number: so leaned back the eye is as far as makes it 4 pixels, as the game's text is
            // pixel-exact.
            const CELL = 9;
            const BACK_CELL = 4;

            function backDistance() {
                const H = layer.clientHeight || window.innerHeight;
                const perMetre = H / 2 / Math.tan((FOV_BACK * Math.PI) / 360);
                return (room.screen.w * perMetre) / (Math.max(fitWidth(), 960) * (BACK_CELL / CELL));
            }

            function seatPose(at) {
                return at === CLOSE
                    ? aimedPose(room.screen.x, room.screen.y, room.screen.z + fillDistance(FOV_SIT), FOV_SIT)
                    // Leaned back in the chair, level and square to the screen, the lens shifted so
                    // the keyboard under it is in view too.
                    : aimedPose(room.screen.x, room.screen.y, room.screen.z + backDistance(), FOV_BACK, 0.2);
            }

            // From p0 at speed v0 and acceleration a0 to p1 in `time`, arriving still, t
            // seconds in: a quintic Hermite curve.
            function quintic(p0, v0, a0, p1, time, t) {
                if (t >= time) return p1;
                const s = Math.max(t, 0) / time;
                const s3 = s * s * s;
                const s4 = s3 * s;
                const s5 = s4 * s;
                return (1 - 10 * s3 + 15 * s4 - 6 * s5) * p0 + (s - 6 * s3 + 8 * s4 - 3 * s5) * time * v0
                    + (0.5 * s * s - 1.5 * s3 + 1.5 * s4 - 0.5 * s5) * time * time * a0 + (10 * s3 - 15 * s4 + 6 * s5) * p1;
            }

            // A bump from 0 at u = 0 up to 1 and back to 0 at u = 1, starting and ending still.
            function bump(u) {
                return (u * u * Math.pow(1 - u, 3)) / 0.03456;
            }

            // The move's pose t seconds in.
            function curve(t) {
                const p = move.from.map((_, c) => quintic(move.from[c], move.speed[c], move.acceleration[c], move.to[c], move.time[c], t));
                MOVES[move.kind].bumps.forEach(([c, size, from, to]) => {
                    const span = move.time[c];
                    const u = (t - from * span) / ((to - from) * span);
                    if (u > 0 && u < 1) p[c] += size * bump(u) * (c === ROLL ? move.roll : 1);
                });
                return p;
            }

            // Starts the move to a posture from wherever the eye is, as fast as it is going.
            function go(to, kind) {
                setLayerStable(false);
                const from = pose.slice();
                let speed;
                let acceleration;
                if (walking) {
                    speed = from.map((v, c) => (prevDt > 0 ? (v - prevPose[c]) / prevDt : 0));
                    acceleration = from.map(() => 0);
                } else if (!move) {
                    speed = from.map(() => 0);
                    acceleration = speed.slice();
                } else {
                    // Mid-move: its speed and acceleration where it is.
                    const h = 1 / 240;
                    const p1 = curve(move.t - h);
                    const p2 = curve(move.t - 2 * h);
                    speed = from.map((v, c) => (v - p1[c]) / h);
                    acceleration = from.map((v, c) => (v - 2 * p1[c] + p2[c]) / (h * h));
                }
                const target = to === STAND ? standPose() : seatPose(to);
                target[YAW] = from[YAW] + wrapAngle(target[YAW] - from[YAW]);
                const times = MOVES[kind].time;
                const time = from.map((_, c) =>
                    (c === X || c === Z || c === FOV ? times[0] : c === Y ? times[1] : c === SWAY ? times[3] : times[2]));
                // Leaning into the turn: towards where the body goes, across the view.
                const across = (target[X] - from[X]) * Math.cos(from[YAW]) - (target[Z] - from[Z]) * Math.sin(from[YAW]);
                move = {
                    kind, from, speed, acceleration, to: target, time, t: 0,
                    end: Math.max.apply(null, time), roll: -Math.sign(across)
                };
                posture = to;
                walking = false;
                player.animating = true;
                if (to === STAND) player.sitting = false;
                markRender();
            }

            // The move is over: walking again, or in the chair.
            function arrive() {
                move = null;
                player.animating = false;
                if (posture === STAND) {
                    walking = true;
                    player.x = pose[X];
                    player.z = pose[Z];
                    body.lastX = player.x;
                    body.lastZ = player.z;
                    body.walkedX = player.x;
                    body.walkedZ = player.z;
                    body.ticks = 0;
                    body.bob = 0;
                    player.vx = player.vz = 0;
                    player.yaw = pose[YAW];
                    player.pitch = pose[PITCH];
                    mouse.x = mouse.y = 0;
                    if (!player.playing) introDone();
                } else {
                    player.sitting = true;
                }
                syncScreenInteractive();
                refreshHint();
                // Seated, nothing moves, so the page is rastered afresh at the size it lands at (sharp),
                // and kept on its own layer, moved without being redrawn, whenever the view moves.
                setLayerStable(posture !== STAND);
                // Standing up came from a key press, which browsers accept as the gesture for
                // catching the mouse again, so looking around just resumes.
                if (posture === STAND && !touch.enabled && !player.locked) requestLook();
            }

            // Moves the pose on by a frame.
            function advance(dt) {
                clock += dt;
                prevPose = pose.slice();
                prevDt = dt;
                if (walking) {
                    walk(dt);
                    if (walking) pose = walkingPose();
                } else if (move) {
                    move.t += dt;
                    if (move.t >= move.end) {
                        pose = move.to.slice();
                        arrive();
                    } else {
                        pose = curve(move.t);
                    }
                }
            }

            // The pose on the camera, swaying a little standing: a slow breath, as Quake's
            // idle. Seated, or leaned in, nothing moves, so the screen's picture holds still.
            function applyPose() {
                const w = pose[SWAY];
                const t = clock * Math.PI * 2;
                let y = pose[Y];
                let yaw = pose[YAW];
                let pitch = pose[PITCH];
                let roll = pose[ROLL];
                if (w) {
                    y += w * 0.0035 * Math.sin(0.21 * t);
                    pitch += w * (0.0022 * Math.sin(0.21 * t + 0.9) + 0.0009 * Math.sin(0.57 * t));
                    yaw += w * 0.0018 * Math.sin(0.13 * t + 2);
                    roll += w * 0.0012 * Math.sin(0.09 * t + 1);
                }
                const cam = room.camera;
                cam.position.set(pose[X], y, pose[Z]);
                cam.rotation.set(0, 0, 0);
                cam.rotateY(yaw);
                cam.rotateX(pitch);
                cam.rotateZ(roll);
                if (Math.abs(cam.fov - pose[FOV]) > 1e-4) setFov(pose[FOV]);
                // The shift moves the frustum's window down, so the scene rises in the view.
                const W = layer.clientWidth || window.innerWidth;
                const H = layer.clientHeight || window.innerHeight;
                if (pose[SHIFT]) cam.setViewOffset(W, H, 0, pose[SHIFT] * H, W, H);
                else if (cam.view) cam.clearViewOffset();
            }

            function lookingAtChair() {
                if (!room || !player.playing || player.animating || player.sitting) return false;
                const cam = room.camera.position;
                const target = tmpChair.set(room.chairX, 0.46, room.chairZ);
                const toChair = tmpToChair.copy(target).sub(cam);
                const dist = toChair.length();
                if (dist < 0.35 || dist > 2.15) return false;
                toChair.divideScalar(dist);
                room.camera.getWorldDirection(tmpForward);
                return tmpForward.dot(toChair) > 0.42;
            }

            function fillDistance(fov) {
                const vFov = (fov * Math.PI) / 180;
                const halfTan = Math.tan(vFov / 2);
                const distH = room.screen.h / 2 / halfTan;
                const distW = room.screen.w / 2 / (halfTan * room.camera.aspect);
                return Math.min(distH, distW);
            }

            // The largest 16:9 that fits the view, in whole pixels: the size the screen lands at
            // leaned in (as the game lands its screen), and so what the page is laid out at.
            function fitWidth() {
                const W = layer.clientWidth || 1280;
                const H = layer.clientHeight || 720;
                return Math.max(1, Math.min(W, Math.floor((H * 16) / 9)));
            }

            function layoutMonitorHtml(worldW, worldH) {
                const aspect = worldW / Math.max(worldH, 0.0001);
                // The page lays out at the viewport width, so the monitor shows the site at
                // exactly the resolution the 2D version would use. Pinning it to a fixed
                // narrower width made text larger, but it also meant going fullscreen grew
                // the panel without growing the layout -- so everything jumped in size.
                const vw = Math.max(fitWidth(), 960);
                const vh = Math.max(Math.round(vw / aspect), 1);
                room.htmlW = vw;
                room.htmlH = vh;
                overlay.style.width = vw + "px";
                overlay.style.height = vh + "px";
                const app = overlay.querySelector(".app");
                if (app) {
                    app.style.width = vw + "px";
                    app.style.height = vh + "px";
                    app.style.maxHeight = vh + "px";
                }
            }

            let needsRender = true;
            const clockFrustum = new THREE.Frustum();
            const clockMatrix = new THREE.Matrix4();
            let clockTickAt = 0;

            // The second hand needs a frame a second, but only while the clock is in view.
            function clockInView() {
                clockMatrix.multiplyMatrices(room.camera.projectionMatrix, room.camera.matrixWorldInverse);
                return clockFrustum.setFromProjectionMatrix(clockMatrix).containsPoint(room.clockAt);
            }
            let screenFacing = true;
            let lastHint = "";

            function markRender() {
                needsRender = true;
            }

            // Whether the page's layer is kept as it is and only moved (a view in motion), or
            // drawn afresh at the size it is shown at (a still one).
            function setLayerStable(moving) {
                overlay.style.willChange = moving ? "transform" : "";
            }

            const pageProject = new THREE.Matrix4();
            const pageModel = new THREE.Matrix4();
            const pageToPixels = new THREE.Matrix4();
            const pageScale = new THREE.Vector3();
            let pageCss = "";
            let pageHair = "";

            // Puts the page on the screen: element pixels to world (the screen's top left, one
            // scale per axis, y down), through the camera, to the view's pixels, as one matrix3d.
            // The camera's projection is used whole, so a lens shift lands right; browsers
            // hit-test transformed elements correctly, so the page stays live. Seated, the eye is
            // square to the screen and the matrix is a plain scale and move: snapped to whole
            // pixels, the text is drawn at the size it is shown at.
            function syncMonitorPage() {
                if (!room || !room.htmlW) return;
                const cam = room.camera;
                cam.updateMatrixWorld();
                cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
                const W = layer.clientWidth;
                const H = layer.clientHeight;
                const g = room.screen;
                pageModel.makeTranslation(g.x - g.w / 2, g.y + g.h / 2, g.z)
                    .scale(pageScale.set(g.w / room.htmlW, -g.h / room.htmlH, 1));
                pageToPixels.set(0.5 * W, 0, 0, 0.5 * W, 0, -0.5 * H, 0, 0.5 * H, 0, 0, 1, 0, 0, 0, 0, 1);
                pageProject.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
                    .multiply(pageModel).premultiply(pageToPixels);
                const e = pageProject.elements;
                const w = e[15];
                if (!(w > 1e-6)) return;
                for (let i = 0; i < 16; i++) e[i] /= w;
                // Flat: the depth is nothing to the browser here.
                e[2] = 0; e[6] = 0; e[10] = 1; e[14] = 0;
                if (player.sitting && !move && Math.abs(e[3]) < 1e-7 && Math.abs(e[7]) < 1e-7) {
                    e[12] = Math.round(e[12]);
                    e[13] = Math.round(e[13]);
                    const cell = Math.round(e[0] * CELL);
                    if (cell > 0 && Math.abs(e[0] * CELL - cell) < 0.15 && Math.abs(e[0] - e[5]) < 0.004) {
                        e[0] = cell / CELL;
                        e[5] = cell / CELL;
                    }
                }
                // Shown smaller than its size (seated, back from the screen, or on foot), a one pixel
                // line would be a fraction of a pixel, faint beside the room's 2 px
                // lines. So the lines are thickened to make up for it. Changing a border's width moves
                // the layout, so this follows the view only when it is still: a fixed thickness on
                // foot, one for the scale it is seated at, and none leaned in.
                if (!move) {
                    const hair = player.sitting ? (e[0] < 0.995 ? Math.min(4, 1.75 / e[0]) + "px" : "") : "3px";
                    if (hair !== pageHair) {
                        pageHair = hair;
                        if (hair) overlay.style.setProperty("--hair", hair);
                        else overlay.style.removeProperty("--hair");
                    }
                }
                const css = "matrix3d(" + Array.prototype.join.call(e, ",") + ")";
                if (css !== pageCss) {
                    pageCss = css;
                    overlay.style.transform = css;
                }
            }

            // The page on the monitor is the real .app element. Browsers hit-test transformed
            // elements correctly, so the only thing between the viewer and a live page is
            // pointer-events on it. Enable it whenever the pointer is free or the crosshair has
            // to read what it rests on; disable it while the view moves.
            function setScreenInteractive(on) {
                if (!room) return;
                overlay.style.pointerEvents = on ? "auto" : "none";
            }

            // "dom"    -- the live page placed on the screen by a matrix: real clicks, hover,
            //             scrolling, and every view but one. It is a DOM overlay, so the room
            //             cannot occlude it.
            // "canvas" -- the page captured into a texture on the screen mesh, for the black
            //             hole alone. Input cannot reach a texture. Uses html-in-canvas when
            //             the flag is on, otherwise a one-shot SVG bake.
            function setScreenMode(mode) {
                if (!room) return;
                const surface = room.htmlSurface;
                if (!surface) mode = "dom";
                if (room.screenMode === mode) return;
                room.screenMode = mode;
                const app = document.querySelector(".app");
                const material = room.screenGlass.material;
                if (mode === "canvas") {
                    // Size the page before baking / capturing so the texture matches the
                    // layout the live page was just showing.
                    if (app && room.htmlW) {
                        app.style.width = room.htmlW + "px";
                        app.style.height = room.htmlH + "px";
                        app.style.maxHeight = room.htmlH + "px";
                    }
                    surface.adopt(app);
                    material.map = surface.texture;
                    material.color.setHex(0xffffff);
                    // opacity, not display/visibility: those two remove the element from
                    // hit testing, and the crosshair aims by hit testing the real page.
                    // The baked texture provides the picture; this stays as the target.
                    overlay.style.display = "";
                    overlay.style.opacity = "0";
                } else {
                    if (app && app.parentNode !== overlay) overlay.appendChild(app);
                    material.map = null;
                    material.color.copy(room.palette.bg);
                    overlay.style.display = "";
                    overlay.style.opacity = "";
                    layoutMonitorHtml(room.screen.w, room.screen.h);
                }
                material.needsUpdate = true;
                markRender();
            }

            // What the crosshair is pointing at, if that is something on the page. The
            // CSS3D subtree is hit-testable, so the viewport centre is all this needs --
            // no raycast, and it resolves the real element rather than guessing from UVs.
            function crosshairTarget() {
                if (!room || !player.playing) return null;
                const rect = layer.getBoundingClientRect();
                const el = document.elementFromPoint(
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2
                );
                if (!el || !overlay.contains(el)) return null;
                return el.closest("a[href], button, [data-target], summary") || null;
            }

            function syncScreenInteractive() {
                // The collapse owns the screen while it runs. Without this an exitPointerLock
                // fired from startBlackHole arrives a frame later and flips the page back to
                // a DOM overlay mid-animation, detaching it from the monitor again.
                if (blackHole) return;
                const usable = player.playing && !player.animating && !inLookMode();
                // Swap to the captured texture only for mouse-look, where occlusion is the
                // whole point and nobody is trying to click. Every other pose -- the intro,
                // sitting down, standing up, reading the page -- keeps the live DOM, so the
                // page is never swapped mid-animation.
                setScreenMode("dom");
                // Hit-testing has to stay live even while the pointer is locked, because
                // that is what the crosshair reads. Pointer lock already stops stray clicks
                // reaching the page -- they are delivered to the locked element instead.
                setScreenInteractive(usable || (player.playing && !player.animating));
            }

            function eventHitsScreen(event) {
                return !!(event.target && event.target.closest("#monitor-overlay, .app"));
            }

            function renderRoom() {
                const domMode = room.screenMode !== "canvas";
                // Run in both modes: in canvas mode the overlay is invisible but still the
                // crosshair's hit-test target, so it has to keep following the monitor.
                updateScreenFacing();
                syncMonitorPage();
                if (!domMode && room.htmlSurface) {
                    room.htmlSurface.repaint();
                    room.htmlSurface.sync();
                }
                room.camera.updateMatrixWorld();
                room.update();
                keySound.listen(room.camera);
                if (blackHole) {
                    // Render the room off-screen, then bend it through the lens shader.
                    room.renderer.setRenderTarget(blackHole.target);
                    room.renderer.clear();
                    room.renderer.render(room.scene, room.camera);
                    room.renderer.setRenderTarget(null);
                    room.renderer.render(blackHole.quadScene, blackHole.quadCamera);
                } else {
                    room.renderer.render(room.scene, room.camera);
                }
            }

            // The intro has ended on its feet: from here the visitor drives.
            function introDone() {
                player.playing = true;
                layoutMonitorHtml(room.screen.w, room.screen.h);
                document.body.classList.add("room-playing");
            }

            function setFov(fov) {
                room.camera.fov = fov;
                room.camera.updateProjectionMatrix();
            }

            // Seated means using the monitor: the cursor is the page's, and the keys lean.
            function leaveLook() {
                if (document.pointerLockElement) document.exitPointerLock();
                setScreenInteractive(false);
                clearPrompt();
                markRender();
            }

            // Walks up to the chair on its own steps, turning to face the desk, and sits from
            // there, as a person would; not a glide from wherever the body was.
            function sitDown() {
                if (!player.playing || player.animating || player.sitting) return;
                leaveLook();
                approach = true;
                approachTime = 0;
                player.animating = true;
            }

            function standUp() {
                if (!player.playing || !player.sitting) return;
                standLook();
                go(STAND, "stand");
            }

            // Getting up comes from a key press, which browsers take as the gesture to catch the
            // mouse; so catch it now, not once the move has ended (by then the gesture has lapsed).
            function standLook() {
                clearPrompt();
                if (touch.enabled) leaveLook();
                else requestLook();
            }

            // Up and down in the chair: step along the places, standing, leaning back, leaning in.
            // Down leaning back stands up.
            function lean(forward) {
                if (!player.playing || walking || approach || blackHole) return false;
                const to = forward ? CLOSE : Math.max(posture - 1, STAND);
                if (to === posture) return false;
                if (to === STAND) standLook();
                else leaveLook();
                go(to, to === STAND ? "stand" : to === CLOSE ? "sit up" : "lean");
                return true;
            }

            // elementFromPoint forces style/layout, so this is polled rather than run on
            // every frame.
            let crossCheckedAt = 0;
            let crossHot = false;

            function refreshCrosshair(now) {
                if (!crossEl || !player.locked) {
                    if (crossHot && crossEl) {
                        crossEl.classList.remove("hot");
                        crossHot = false;
                    }
                    return;
                }
                if (now - crossCheckedAt < 90) return;
                crossCheckedAt = now;
                const hot = !!crosshairTarget();
                if (hot !== crossHot) {
                    crossHot = hot;
                    crossEl.classList.toggle("hot", hot);
                }
            }

            function clearPrompt() {
                lastHint = "";
                if (prompt) {
                    prompt.textContent = "";
                    prompt.classList.remove("show");
                }
            }

            // Look mode is "the room has the controls": pointer lock on desktop, the touch
            // sticks on mobile. Out of it, the page on the monitor takes the input.
            // Sitting at the desk IS the screen mode: you sit down in order to use the
            // computer, so the posture decides who the input belongs to. On desktop pointer
            // lock already expresses the same thing, and the browser owns that.
            function inLookMode() {
                return touch.enabled ? !player.sitting : player.locked;
            }

            // The HUD is one contextual line plus a static key legend, rather than a
            // paragraph of instructions restated every frame.
            function refreshHint() {
                if (player.animating || blackHole) return;
                document.body.classList.toggle("room-look", inLookMode());
                document.body.classList.toggle("room-seat", player.sitting);
                document.body.classList.toggle("room-close", player.sitting && posture === CLOSE);

                let next = "";
                if (player.sitting) {
                    next = touch.enabled
                        ? "Tap the screen \u00b7 <b>STAND</b> to get up"
                        : posture === CLOSE
                            ? "<b>\u2193</b> lean back"
                            : "<b>\u2191</b> lean in \u00b7 <b>\u2193</b> stand";
                } else if (!inLookMode()) {
                    // Checked before the desk hint: in screen mode the USE button is hidden,
                    // so prompting for it would point at a control that is not on screen.
                    next = "";
                } else if (lookingAtChair()) {
                    next = touch.enabled ? "<b>USE</b> the desk" : "<b>E</b> use the desk";
                }
                if (next !== lastHint) {
                    lastHint = next;
                    if (prompt) {
                        prompt.innerHTML = next;
                        prompt.classList.toggle("show", next !== "");
                    }
                }
                if (deskBtn) deskBtn.textContent = player.sitting ? "STAND" : "USE";
            }

            function updateScreenFacing() {
                if (blackHole) return;
                const cam = room.camera.position;
                const toCam = tmpToCam.set(
                    cam.x - room.screen.x,
                    cam.y - room.screen.y,
                    cam.z - room.screen.z
                );
                const normal = tmpNormal.set(0, 0, 1).applyQuaternion(room.screenGlass.quaternion);
                // Two thresholds, not one: a single cutoff makes the overlay strobe on and
                // off whenever the viewing angle hovers right on the boundary.
                const facing = toCam.dot(normal);
                if (screenFacing && facing < 0.02) screenFacing = false;
                else if (!screenFacing && facing > 0.14) screenFacing = true;
                overlay.style.visibility = screenFacing ? "visible" : "hidden";
            }

            let last = 0;
            let raf = 0;
            let blackHole = null;

            // Easter egg: pressing ? once you are already inside the room. The room is
            // rendered off-screen and put through one post pass that does two things at
            // once -- it bends the room into the singularity, and it draws the black hole
            // itself as orbiting particles with cycling colour.
            //
            // The particle half follows React Bits Pro's Black Hole: a fixed set of orbiting
            // points accumulated as glow/distance, each on its own colour cycle with a phase
            // offset per channel, mirrored kaleidoscope-style, faded by distance and finally
            // put through a contrast exponent. Its parameter names are kept so the defaults
            // below line up with that component's.
            // The collapse, in seconds from the click: the monitor shakes, then spins and shrinks
            // into a point (to SHRINK); space bends round it (from BEND, to GROW) until the
            // horizon has grown to swallow the whole view (to END); then the words.
            const HOLE = { shake: 0.9, shrink: 3.6, seed: 1.6, bend: 2.2, disk: 3.8, grow: 6.8, end: 8.6 };
            const HOLE_EINSTEIN = 0.34;              // the lens's ring, in screen heights, at its widest

            const LENS_VERT = [
                "varying vec2 vUv;",
                "void main() {",
                "    vUv = uv;",
                "    gl_Position = vec4(position.xy, 0.0, 1.0);",
                "}"
            ].join("\n");

            // A black hole drawn the way the room is: the room's own picture bent by a point-mass
            // lens (an image at radius r shows what lies at r - E^2/r: past the Einstein ring E
            // the room is only bent, inside it turned over), an absolutely black shadow, a thin
            // photon ring, and an accretion disk in the theme's accent as concentric dashed lines
            // that turn faster the nearer they are, brighter on the side coming towards us. The
            // lines are antialiased strokes, a pixel or two wide, as the room's are.
            const LENS_FRAG = [
                "precision highp float;",
                "#define PI 3.14159265359",
                "uniform sampler2D u_image;",
                "uniform vec2 u_center;",
                "uniform float u_aspect;",
                "uniform float u_px;",
                "uniform float u_E;",
                "uniform float u_Rs;",
                "uniform float u_swirl;",
                "uniform float u_disk;",
                "uniform float u_flare;",
                "uniform float u_seed;",
                "uniform float u_wave;",
                "uniform float u_after;",
                "uniform float u_time;",
                "uniform float u_dim;",
                "uniform vec3 u_accent;",
                "uniform vec3 u_bg;",
                "varying vec2 vUv;",
                "",
                // A line d away from its middle, w pixels wide, antialiased.
                "float stroke(float d, float w) {",
                "    float h = 0.5 * w * u_px;",
                "    return 1.0 - smoothstep(h - u_px, h + u_px, abs(d));",
                "}",
                "",
                // n dashes round a circle, turning at speed s.
                "float dashes(float a, float n, float s) {",
                "    float f = fract(a * n / (2.0 * PI) + s);",
                "    return smoothstep(0.0, 0.05, f) * (1.0 - smoothstep(0.64, 0.69, f));",
                "}",
                "",
                "void main() {",
                "    vec2 p = (vUv - u_center) * vec2(u_aspect, 1.0);",
                "    float r = length(p);",
                "    vec2 dir = p / max(r, 1e-5);",
                "    float ang = atan(p.y, p.x);",
                "",
                // -- the room, bent --------------------------------------------------------
                "    float E = max(u_E, 1e-4);",
                // Ripples running out from the centre, as space settles under a growing mass.
                "    float ripple = u_wave * 0.0028 * sin(r * 60.0 - u_time * 7.0) * exp(-r * 3.2);",
                "    float beta = r - E * E / max(r, 1e-4) + ripple;",
                // Frame dragging: what is nearer turns further.
                "    float turn = u_swirl * E * E / (r * r + 0.25 * E * E);",
                "    float cs = cos(turn);",
                "    float sn = sin(turn);",
                "    vec2 d2 = vec2(cs * dir.x - sn * dir.y, sn * dir.x + cs * dir.y);",
                "    vec2 uv = u_center + d2 * beta / vec2(u_aspect, 1.0);",
                "    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);",
                "    vec3 col = mix(u_bg, texture2D(u_image, uv).rgb, inside);",
                "    col *= 1.0 - u_dim;",
                "",
                "    vec3 hot = mix(u_accent, vec3(1.0), 0.6);",
                "    float Rs = u_Rs;",
                "    float shadow = 1.0 - smoothstep(Rs - u_px, Rs + u_px, r);",
                "",
                // -- the far side of the disk, bent round the shadow --------------------------
                "    float arcs = 0.0;",
                "    for (int i = 0; i < 4; i++) {",
                "        float fi = float(i);",
                "        float rad = Rs * (1.10 + 0.17 * fi);",
                "        float turnRate = 0.55 / (1.0 + 0.45 * fi);",
                "        arcs += stroke(r - rad, 1.8) * dashes(ang, 7.0 + 5.0 * fi, u_time * turnRate) * (1.0 - 0.17 * fi);",
                "    }",
                "    float beam = 1.0 - 0.6 * cos(ang);",
                "",
                // -- the disk itself, seen nearly edge on: an ellipse in the plane ---------------
                "    float tilt = 0.24;",
                "    vec2 q = vec2(p.x, p.y / tilt);",
                "    float rn = length(q) / max(Rs, 1e-4);",
                "    float aq = atan(q.y, q.x);",
                "    float cell = rn * 2.2;",
                "    float onBand = step(1.9, rn) * step(rn, 5.4);",
                "    float cellDist = abs(fract(cell) - 0.5) / 2.2 * Rs;",
                "    float ring = floor(cell);",
                "    float band = onBand * stroke(cellDist, 1.8) *",
                "        dashes(aq, 9.0 + 4.0 * mod(ring, 4.0), u_time * 1.5 / pow(max(rn, 1.0), 1.5)) *",
                "        pow(1.9 / max(rn, 1.9), 1.3);",
                // The shadow hides the disk behind it (the lensed arcs above carry its far side round).
                "    band *= 1.0 - shadow;",
                "    float beamB = 1.0 - 0.6 * cos(aq);",
                "",
                "    float lines = clamp(arcs * beam + band * beamB, 0.0, 1.0) * u_disk;",
                "    float photon = stroke(r - Rs * 1.03, 2.4) * (0.8 + 0.2 * sin(u_time * 3.0 + ang * 2.0));",
                "    float present = clamp(Rs * 18.0, 0.0, 1.0);",
                "",
                "    col = mix(col, vec3(0.0), shadow);",
                "    col = mix(col, mix(u_accent, hot, clamp(0.3 + 0.55 * u_flare, 0.0, 1.0)), clamp(lines * (1.0 + 0.8 * u_flare), 0.0, 1.0));",
                "    col = mix(col, hot, photon * present * (1.0 - u_dim));",
                "    col += u_accent * exp(-abs(r - Rs * 1.1) / (Rs * 0.9 + 1e-3)) * 0.16 * present * (1.0 - shadow);",
                "",
                // -- the point the monitor falls into, before there is a hole ----------------------
                "    float seed = u_seed * exp(-r * r / (0.0004 + 0.0012 * u_seed));",
                "    col = mix(col, hot, clamp(seed, 0.0, 1.0));",
                "    col += u_accent * 0.5 * u_seed * exp(-r * r / 0.012);",
                "",
                // -- afterwards: a faint ring still turning behind the words ----------------------
                "    col = mix(col, u_accent, stroke(r - 0.34, 1.6) * dashes(ang, 44.0, u_time * 0.04) * u_after * 0.3);",
                "    gl_FragColor = vec4(col, 1.0);",
                "}"
            ].join("\n");

            // The sound of it: a drone sweeping down, noise closing like a hand over an ear, and
            // at the end a thump and then nothing. It shares the keys' audio context.
            const holeSound = (() => {
                let nodes = null;
                return {
                    start(ctx, seconds) {
                        if (!ctx || ctx.state !== "running") return;
                        const now = ctx.currentTime;
                        const out = ctx.createGain();
                        out.gain.setValueAtTime(0, now);
                        out.gain.linearRampToValueAtTime(0.3, now + seconds * 0.8);
                        out.connect(ctx.destination);
                        const oscillators = [[55, 22, "sine", -7], [82, 30, "triangle", 7]].map(([from, to, type, detune]) => {
                            const o = ctx.createOscillator();
                            o.type = type;
                            o.detune.value = detune;
                            o.frequency.setValueAtTime(from, now);
                            o.frequency.exponentialRampToValueAtTime(to, now + seconds);
                            o.connect(out);
                            o.start(now);
                            return o;
                        });
                        const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
                        const data = buffer.getChannelData(0);
                        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
                        const noise = ctx.createBufferSource();
                        noise.buffer = buffer;
                        noise.loop = true;
                        const filter = ctx.createBiquadFilter();
                        filter.type = "lowpass";
                        filter.frequency.setValueAtTime(1400, now);
                        filter.frequency.exponentialRampToValueAtTime(90, now + seconds);
                        const hiss = ctx.createGain();
                        hiss.gain.value = 0.5;
                        noise.connect(filter);
                        filter.connect(hiss);
                        hiss.connect(out);
                        noise.start(now);
                        nodes = { ctx, out, oscillators, noise, seconds, start: now };
                    },
                    // The horizon is crossed: a thump, and silence.
                    thump() {
                        if (!nodes) return;
                        const { ctx, out } = nodes;
                        const now = ctx.currentTime;
                        out.gain.cancelScheduledValues(now);
                        out.gain.setValueAtTime(out.gain.value, now);
                        out.gain.linearRampToValueAtTime(0, now + 0.15);
                        const hit = ctx.createOscillator();
                        const level = ctx.createGain();
                        hit.frequency.setValueAtTime(52, now);
                        hit.frequency.exponentialRampToValueAtTime(18, now + 1.4);
                        level.gain.setValueAtTime(0.7, now);
                        level.gain.exponentialRampToValueAtTime(0.001, now + 1.6);
                        hit.connect(level);
                        level.connect(ctx.destination);
                        hit.start(now);
                        hit.stop(now + 1.7);
                    },
                    stop() {
                        if (!nodes) return;
                        const { ctx, out, oscillators, noise } = nodes;
                        const now = ctx.currentTime;
                        out.gain.cancelScheduledValues(now);
                        out.gain.setValueAtTime(out.gain.value, now);
                        out.gain.linearRampToValueAtTime(0, now + 0.1);
                        oscillators.forEach((o) => o.stop(now + 0.15));
                        noise.stop(now + 0.15);
                        nodes = null;
                    }
                };
            })();

            function startBlackHole() {
                if (blackHole || !room || !player.playing) return;
                if (document.pointerLockElement) document.exitPointerLock();
                setScreenInteractive(false);
                releaseKeys();
                move = null;
                approach = false;
                walking = false;
                player.animating = false;
                player.vx = player.vz = 0;

                // With HTML-in-Canvas the page is already a texture in the scene, so it gets
                // lensed along with everything else. Without it the page is a DOM overlay
                // the shader cannot touch, and the spiral below carries it in instead.
                if (room.htmlSurface) setScreenMode("canvas");

                const size = new THREE.Vector2();
                room.renderer.getSize(size);
                const dpr = room.renderer.getPixelRatio();
                const target = new THREE.WebGLRenderTarget(
                    Math.max(1, Math.floor(size.x * dpr)),
                    Math.max(1, Math.floor(size.y * dpr)),
                    { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat }
                );

                const palette = roomPalette();
                const material = new THREE.ShaderMaterial({
                    uniforms: {
                        u_image: { value: target.texture },
                        u_center: { value: new THREE.Vector2(0.5, 0.5) },
                        u_aspect: { value: Math.max(size.x, 1) / Math.max(size.y, 1) },
                        u_px: { value: 1 / target.height },
                        u_E: { value: 0 },
                        u_Rs: { value: 0 },
                        u_swirl: { value: 0 },
                        u_disk: { value: 0 },
                        u_flare: { value: 0 },
                        u_seed: { value: 0 },
                        u_wave: { value: 0 },
                        u_after: { value: 0 },
                        u_time: { value: 0 },
                        u_dim: { value: 0 },
                        u_accent: { value: palette.accent.clone() },
                        u_bg: { value: palette.bg.clone() }
                    },
                    vertexShader: LENS_VERT,
                    fragmentShader: LENS_FRAG,
                    depthTest: false,
                    depthWrite: false
                });
                const quadScene = new THREE.Scene();
                quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

                // Swallow the monitor as one object. Animating only the screen left the
                // bezel, neck and foot standing on the desk while the picture spiralled off
                // them -- which is exactly what read as the page not being attached. Parent
                // every part of the monitor to a pivot at the screen centre and pull that.
                const pivot = new THREE.Group();
                pivot.position.set(room.screen.x, room.screen.y, room.screen.z);
                room.scene.add(pivot);
                const parts = [room.screenGlass].concat(room.monitorProxy || []);
                const homes = parts.map((mesh) => ({
                    mesh: mesh,
                    parent: mesh.parent,
                    position: mesh.position.clone()
                }));
                parts.forEach((mesh) => {
                    mesh.position.sub(pivot.position);
                    pivot.add(mesh);
                });

                blackHole = {
                    target: target,
                    material: material,
                    quadScene: quadScene,
                    quadCamera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
                    start: performance.now(),
                    last: performance.now(),
                    clock: 0,
                    done: false,
                    doneAt: 0,
                    camPos: room.camera.position.clone(),
                    camQuat: room.camera.quaternion.clone(),
                    pivot: pivot,
                    homes: homes,
                    pivotHome: pivot.position.clone()
                };
                clearPrompt();
                markRender();
                document.body.classList.add("room-collapse");
                if (!touch.enabled) holeSound.start(keySound.context(), HOLE.end);
            }

            const holeShake = new THREE.Euler();
            const holeQuat = new THREE.Quaternion();

            function stepBlackHole(now) {
                const h = blackHole;
                const t = (now - h.start) / 1000;
                const dt = Math.max(0, Math.min(0.1, (now - h.last) / 1000));
                h.last = now;
                const smooth = (a, b, x) => {
                    const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
                    return u * u * (3 - 2 * u);
                };

                // The monitor: it shakes, then spins up and shrinks into a point, stretched a little
                // on the way, the picture still on it. Screen, bezel, riser and base ride one pivot.
                const pivot = h.pivot;
                const shake = smooth(0, HOLE.shake, t) * (1 - smooth(HOLE.shake, HOLE.shake + 0.6, t));
                const fall = smooth(HOLE.shake, HOLE.shrink, t);
                const size = Math.pow(1 - fall, 1.6);
                pivot.position.set(
                    h.pivotHome.x + (Math.sin(t * 71) + Math.sin(t * 43)) * 0.0025 * shake,
                    h.pivotHome.y + (Math.sin(t * 59) + Math.sin(t * 37)) * 0.0025 * shake,
                    h.pivotHome.z);
                pivot.rotation.z = Math.PI * 2 * 2.5 * fall * fall * fall + Math.sin(t * 83) * 0.006 * shake;
                pivot.scale.set(Math.max(size * (1 - 0.35 * fall), 1e-4), Math.max(size * (1 + 1.4 * fall * fall), 1e-4), Math.max(size, 1e-4));
                pivot.visible = fall < 0.999;

                // Where the singularity is on the view: the screen's middle.
                lensCenter.set(h.pivotHome.x, h.pivotHome.y, h.pivotHome.z);
                lensCenter.project(room.camera);
                const u = h.material.uniforms;
                u.u_center.value.set(lensCenter.x * 0.5 + 0.5, lensCenter.y * 0.5 + 0.5);

                // The lens widens from BEND to GROW; then the horizon grows past the edges of the view.
                const lens = smooth(HOLE.bend, HOLE.grow, t);
                const E = HOLE_EINSTEIN * Math.pow(lens, 1.35);
                const swallow = smooth(HOLE.grow, HOLE.end, t);
                u.u_E.value = E;
                u.u_Rs.value = E * 0.62 + 1.6 * swallow * swallow;
                u.u_swirl.value = 1.3 * lens;
                u.u_disk.value = smooth(HOLE.disk, HOLE.disk + 1.4, t) * (1 - smooth(HOLE.end - 0.9, HOLE.end - 0.2, t));
                u.u_flare.value = smooth(HOLE.grow - 0.6, HOLE.end - 0.6, t) * 1.5;
                u.u_seed.value = smooth(HOLE.seed, HOLE.shrink, t) * (1 - smooth(HOLE.shrink, HOLE.shrink + 1.4, t));
                u.u_wave.value = smooth(HOLE.bend - 0.4, HOLE.bend + 1.2, t) * (1 - swallow);
                u.u_dim.value = smooth(HOLE.end - 0.5, HOLE.end, t);
                u.u_after.value = h.doneAt ? Math.min(1, (now - h.doneAt) / 2600) : 0;
                // Time slows towards the horizon.
                h.clock += dt * (1 + 2 * smooth(3, 6, t)) * (1 - 0.88 * smooth(HOLE.grow + 0.4, HOLE.end, t));
                u.u_time.value = h.clock;

                // The view shudders as the pull grows.
                const tremor = 0.0035 * smooth(1, HOLE.grow, t) * (1 - swallow * 0.5);
                holeShake.set(
                    (Math.sin(t * 47) + Math.sin(t * 29)) * tremor,
                    (Math.sin(t * 53) + Math.sin(t * 31)) * tremor,
                    (Math.sin(t * 41) + Math.sin(t * 23)) * tremor * 1.5);
                room.camera.quaternion.copy(h.camQuat).multiply(holeQuat.setFromEuler(holeShake));

                if (t >= HOLE.end && !h.done) {
                    h.done = true;
                    h.doneAt = now;
                    pivot.visible = false;
                    overlay.style.visibility = "hidden";
                    room.camera.quaternion.copy(h.camQuat);
                    holeSound.thump();
                    document.body.classList.add("room-void");
                }
                markRender();
            }

            function clearBlackHole() {
                document.body.classList.remove("room-void", "room-collapse");
                holeSound.stop();
                if (!blackHole) return;
                room.camera.position.copy(blackHole.camPos);
                room.camera.quaternion.copy(blackHole.camQuat);
                room.renderer.setRenderTarget(null);
                blackHole.target.dispose();
                blackHole.material.dispose();
                blackHole.quadScene.traverse((node) => {
                    if (node.geometry) node.geometry.dispose();
                });
                blackHole.homes.forEach((home) => {
                    home.parent.add(home.mesh);
                    home.mesh.position.copy(home.position);
                });
                blackHole.pivot.visible = true;
                room.scene.remove(blackHole.pivot);
                overlay.style.visibility = "";
                overlay.style.filter = "";
                overlay.style.opacity = "";
                blackHole = null;
            }

            let swayAt = 0;

            function tick(now) {
                raf = requestAnimationFrame(tick);
                const frameMs = now - last;
                // A frame's rAF timestamp can predate `last` (set when the room was entered).
                const dt = Math.max(0, Math.min(0.05, frameMs / 1000 || 0.016));
                last = now;
                // Holding pointer lock is not motion: the camera only changes when the mouse
                // actually moves, and onMouseMove already asks for a frame. Treating "locked"
                // as "dirty" meant standing still in mouse-look redrew the room forever.
                if (player.animating || touch.stick.active || mouse.x || mouse.y ||
                    keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD ||
                    keys.ArrowUp || keys.ArrowLeft || keys.ArrowDown || keys.ArrowRight ||
                    Math.hypot(player.vx, player.vz) > 0.004) {
                    needsRender = true;
                }
                // Standing in mouse-look the eyes sway; half the frames are plenty for a breath.
                if (walking && swayOn() && now - swayAt > 33) {
                    swayAt = now;
                    needsRender = true;
                }

                if (room.keyboard.moving) {
                    needsRender = true;
                    room.keyboard.step(dt);
                }
                keySound.glide(dt, posture === CLOSE);

                if (player.playing && now - clockTickAt > 1000) {
                    clockTickAt = now;
                    if (clockInView()) needsRender = true;
                }

                if (blackHole) {
                    stepBlackHole(now);
                } else if (walking || move) {
                    advance(dt);
                    applyPose();
                }

                if (player.playing && !player.animating && !blackHole) {
                    refreshHint();
                    refreshCrosshair(now);
                }

                if (!needsRender) return;
                needsRender = false;
                renderRoom();
                // Only frames we actually drew say anything about how hard this device is
                // working; sampling idle frames would ratchet the resolution up and then
                // collapse it again the moment you moved.
                if (frameMs > 0 && frameMs < 500) adaptResolution(now, frameMs);
            }

            function startAnimation() {
                room.resize();
                layoutMonitorHtml(room.screen.w, room.screen.h);
                clock = 0;
                walking = false;
                approach = false;
                move = null;
                posture = CLOSE;
                player.playing = false;
                player.animating = false;
                player.sitting = false;
                player.vx = player.vz = 0;
                document.body.classList.remove("room-playing");
                // The intro starts leaned in on the screen, the page filling the view as the 2D
                // one does, and pulls back to standing behind the chair.
                pose = seatPose(CLOSE);
                prevPose = pose.slice();
                applyPose();
                if (reduceMotion) {
                    posture = STAND;
                    pose = standPose();
                    move = {};
                    arrive();
                    applyPose();
                } else {
                    go(STAND, "intro");
                    clearPrompt();
                }
                markRender();
                if (!raf) raf = requestAnimationFrame(tick);
                renderRoom();
            }

            function requestLook() {
                setScreenInteractive(false);
                const pending = layer.requestPointerLock();
                if (pending && typeof pending.catch === "function") pending.catch(() => {});
            }

            function lockPointer() {
                if (!document.body.classList.contains("room-active")) return;
                if (player.playing && player.animating) return;
                if (player.sitting) return;
                requestLook();
            }

            function onMouseMove(event) {
                if (!player.locked || !player.playing || player.animating || player.sitting) return;
                // Raw, a frame's worth at a time: walk() turns it into degrees.
                mouse.x += event.movementX;
                mouse.y += event.movementY;
                markRender();
            }

            function onPointerLock() {
                player.locked = document.pointerLockElement === layer;
                syncScreenInteractive();
                refreshHint();
            }

            function restoreApp() {
                const app = document.querySelector(".app");
                if (app) {
                    app.style.width = "";
                    app.style.height = "";
                    app.style.maxHeight = "";
                }
                if (!room || !room.appHome || !app) return;
                if (room.appHome.next && room.appHome.next.parentNode === room.appHome.parent) {
                    room.appHome.parent.insertBefore(app, room.appHome.next);
                } else {
                    room.appHome.parent.appendChild(app);
                }
                room.appHome = null;
            }

            function exitRoom() {
                if (document.pointerLockElement) document.exitPointerLock();
                player.playing = false;
                player.animating = false;
                player.locked = false;
                player.sitting = false;
                walking = false;
                approach = false;
                move = null;
                mouse.x = mouse.y = 0;
                releaseKeys();
                setScreenInteractive(false);
                clearBlackHole();
                // Hand the page back to the CSS3D mount before restoring it, so it never
                // ends up orphaned inside the capture canvas.
                setScreenMode("dom");
                if (room) setFov(FOV_STAND);
                cancelAnimationFrame(raf);
                raf = 0;
                restoreApp();
                overlay.style.display = "";
                overlay.style.opacity = "";
                overlay.style.visibility = "";
                clearPrompt();
                resetTouch();
                if (touch.enabled) releaseLandscape();
                document.body.classList.remove("room-active", "room-playing", "room-touch", "room-look", "room-close", "room-seat");
                layer.hidden = true;
            }

            // Landscape gate, in the order the user actually experiences it: ask for
            // landscape first, and only once the phone is turned do we go fullscreen and
            // start the room. Fullscreen has to be requested from a tap -- an
            // orientationchange is not a user gesture and browsers refuse it -- which is
            // why the gate swaps to an explicit button rather than entering by itself.
            let awaitingLandscape = false;

            async function goFullscreen() {
                const root = document.documentElement;
                try {
                    if (!document.fullscreenElement && root.requestFullscreen) {
                        await root.requestFullscreen({ navigationUI: "hide" });
                    }
                } catch (error) {
                    /* refused -- the room still runs, just not edge to edge */
                }
                try {
                    // Only meaningful once fullscreen; iOS Safari refuses outright.
                    if (screen.orientation && screen.orientation.lock) {
                        await screen.orientation.lock("landscape");
                    }
                } catch (error) {
                    /* the user is already holding it sideways; nothing to enforce */
                }
            }

            function paintRotateGate() {
                if (!rotateGate) return;
                const ready = isLandscape();
                const title = document.getElementById("room-rotate-title");
                const copy = document.getElementById("room-rotate-copy");
                const go = document.getElementById("room-rotate-go");
                // Deliberately says nothing about what is on the other side.
                if (title) title.textContent = ready ? "Ready" : "Turn your phone sideways";
                if (copy) copy.textContent = ready ? "Tap to continue." : "This one needs landscape.";
                if (go) go.hidden = !ready;
                rotateGate.classList.toggle("is-ready", ready);
            }

            function showRotateGate() {
                awaitingLandscape = true;
                if (rotateGate) rotateGate.hidden = false;
                paintRotateGate();
            }

            function hideRotateGate() {
                awaitingLandscape = false;
                if (rotateGate) rotateGate.hidden = true;
            }

            function releaseLandscape() {
                try {
                    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
                } catch (error) {
                    /* nothing to undo */
                }
                if (document.fullscreenElement && document.exitFullscreen) {
                    document.exitFullscreen().catch(() => {});
                }
            }

            function onOrientationChange() {
                if (!awaitingLandscape) return;
                paintRotateGate();
            }

            window.addEventListener("orientationchange", () => setTimeout(onOrientationChange, 120));
            window.addEventListener("resize", onOrientationChange);
            if (rotateCancel) rotateCancel.addEventListener("click", () => {
                hideRotateGate();
                releaseLandscape();
            });
            const rotateGo = document.getElementById("room-rotate-go");
            if (rotateGo) rotateGo.addEventListener("click", async () => {
                hideRotateGate();
                await goFullscreen();
                enterRoom();
            });

            async function enterRoom() {
                touch.enabled = isTouchDevice();
                if (touch.enabled && !isLandscape()) {
                    showRotateGate();
                    return;
                }
                if (touch.enabled) await goFullscreen();
                document.body.classList.toggle("room-touch", touch.enabled);
                document.body.classList.add("room-active");
                layer.hidden = false;
                // Sound only starts from a gesture, so from this click.
                if (!touch.enabled) keySound.start();
                if (touch.enabled) {
                    resetTouch();
                } else {
                    requestLook();
                }
                try {
                    await ensureRoomLibs();
                    if (!room) room = createRoom();
                    if (!touch.enabled) keySound.start(room.keyboardAt);
                    if (room.propsReady) await room.propsReady;
                    const app = document.querySelector(".app");
                    if (app && app.parentNode !== room.mount) {
                        room.appHome = { parent: app.parentNode, next: app.nextSibling };
                        room.mount.appendChild(app);
                    }
                    room.resize();
                    applyPalette(room);
                    last = performance.now();
                    startAnimation();
                } catch (error) {
                    console.error(error);
                    if (document.pointerLockElement) document.exitPointerLock();
                    document.body.classList.remove("room-active");
                    layer.hidden = true;
                    window.alert("The 3D room could not start in this browser.");
                }
            }

            // -- touch controls --------------------------------------------------------
            // The scheme every mobile shooter converges on: a floating stick under the left
            // thumb, free-look anywhere on the right, and actions as real buttons out of
            // both thumbs' way. Pointer events carry an id, which is what lets the two
            // thumbs drive movement and look at the same time.
            // Kept in step with the CSS above, so the nub never rides outside its ring.
            function stickRadius() {
                return window.innerHeight < 470 ? 46 : 58;
            }
            const STICK_DEADZONE = 0.14;

            function resetTouch() {
                touch.stick.active = false;
                touch.stick.x = 0;
                touch.stick.y = 0;
                touch.stick.id = -1;
                touch.look.id = -1;
                if (stickEl) stickEl.classList.remove("active");
                if (nubEl) nubEl.style.transform = "";
            }

            function placeStick(clientX, clientY) {
                const rect = layer.getBoundingClientRect();
                touch.stick.baseX = clientX;
                touch.stick.baseY = clientY;
                if (!stickEl) return;
                stickEl.style.left = (clientX - rect.left) + "px";
                stickEl.style.top = (clientY - rect.top) + "px";
                stickEl.classList.add("active");
            }

            function updateStick(clientX, clientY) {
                const radius = stickRadius();
                let dx = clientX - touch.stick.baseX;
                let dy = clientY - touch.stick.baseY;
                const dist = Math.hypot(dx, dy);
                if (dist > radius) {
                    dx = (dx / dist) * radius;
                    dy = (dy / dist) * radius;
                }
                if (nubEl) nubEl.style.transform = "translate(" + dx + "px," + dy + "px)";

                let nx = dx / radius;
                let ny = -dy / radius;
                const mag = Math.hypot(nx, ny);
                if (mag < STICK_DEADZONE) {
                    touch.stick.x = 0;
                    touch.stick.y = 0;
                } else {
                    // Rescale past the dead zone so the first millimetre of travel is not a
                    // jump straight to walking speed.
                    const scaled = (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE) / mag;
                    touch.stick.x = nx * scaled;
                    touch.stick.y = ny * scaled;
                }
                markRender();
            }

            function onPointerDown(event) {
                if (!touch.enabled || !player.playing || player.sitting) return;
                if (event.target.closest(".touch-btn, .room-exit")) return;
                const rect = layer.getBoundingClientRect();
                const isLeft = (event.clientX - rect.left) < rect.width * 0.5;
                if (isLeft && touch.stick.id === -1) {
                    touch.stick.id = event.pointerId;
                    touch.stick.active = true;
                    placeStick(event.clientX, event.clientY);
                    updateStick(event.clientX, event.clientY);
                    event.preventDefault();
                } else if (!isLeft && touch.look.id === -1) {
                    touch.look.id = event.pointerId;
                    touch.look.lastX = event.clientX;
                    touch.look.lastY = event.clientY;
                    event.preventDefault();
                }
            }

            function onPointerMove(event) {
                if (!touch.enabled) return;
                if (event.pointerId === touch.stick.id) {
                    updateStick(event.clientX, event.clientY);
                    event.preventDefault();
                } else if (event.pointerId === touch.look.id) {
                    if (!player.animating && !player.sitting) {
                        player.yaw -= (event.clientX - touch.look.lastX) * TOUCH_LOOK_SCALE;
                        player.pitch -= (event.clientY - touch.look.lastY) * TOUCH_LOOK_SCALE;
                        player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, player.pitch));
                        markRender();
                    }
                    touch.look.lastX = event.clientX;
                    touch.look.lastY = event.clientY;
                    event.preventDefault();
                }
            }

            function onPointerUp(event) {
                if (event.pointerId === touch.stick.id) {
                    touch.stick.id = -1;
                    touch.stick.active = false;
                    touch.stick.x = 0;
                    touch.stick.y = 0;
                    if (stickEl) stickEl.classList.remove("active");
                    if (nubEl) nubEl.style.transform = "";
                    markRender();
                } else if (event.pointerId === touch.look.id) {
                    touch.look.id = -1;
                }
            }

            layer.addEventListener("pointerdown", onPointerDown);
            layer.addEventListener("pointermove", onPointerMove, { passive: false });
            layer.addEventListener("pointerup", onPointerUp);
            layer.addEventListener("pointercancel", onPointerUp);

            // Touch scrolling inside a CSS3D-transformed subtree fails for the same reason
            // the wheel does, so drags on the page are turned into scrollTop directly. The
            // page is projected smaller than the viewport, so a finger travelling n screen
            // pixels has to move the content by more than n page pixels to feel attached.
            const dragScroll = { id: -1, target: null, lastY: 0 };

            function screenScrollRatio() {
                const app = overlay.querySelector(".app");
                if (!app || !room || !room.htmlW) return 1;
                const rect = app.getBoundingClientRect();
                return rect.width < 1 ? 1 : room.htmlW / rect.width;
            }

            layer.addEventListener("pointerdown", (event) => {
                if (!player.playing || inLookMode() || event.pointerType === "mouse") return;
                const target = scrollableUnder(event.clientX, event.clientY);
                if (!target) return;
                dragScroll.id = event.pointerId;
                dragScroll.target = target;
                dragScroll.lastY = event.clientY;
            });

            layer.addEventListener("pointermove", (event) => {
                if (event.pointerId !== dragScroll.id || !dragScroll.target) return;
                dragScroll.target.scrollTop -= (event.clientY - dragScroll.lastY) * screenScrollRatio();
                dragScroll.lastY = event.clientY;
                event.preventDefault();
            }, { passive: false });

            const endDragScroll = (event) => {
                if (event.pointerId !== dragScroll.id) return;
                dragScroll.id = -1;
                dragScroll.target = null;
            };
            layer.addEventListener("pointerup", endDragScroll);
            layer.addEventListener("pointercancel", endDragScroll);


            if (deskBtn) {
                deskBtn.addEventListener("click", (event) => {
                    event.stopPropagation();
                    if (player.sitting) standUp();
                    else sitDown();
                });
            }

            window.updateRoomTheme = function () {
                if (!room) return;
                applyPalette(room);
                // The captured page carries its own colours, so it needs a fresh capture.
                if (room.htmlSurface) room.htmlSurface.repaint();
                markRender();
            };

            enterBtn.addEventListener("click", (event) => {
                if (document.body.classList.contains("room-active")) {
                    event.preventDefault();
                    startBlackHole();
                    return;
                }
                enterRoom();
            });
            if (exitBtn) exitBtn.addEventListener("click", exitRoom);
            layer.addEventListener("click", (event) => {
                if (!event.isTrusted) return;
                if (event.target.closest(".room-exit, .touch-btn")) return;
                // While looking around there is no cursor, so the crosshair is the pointer:
                // click whatever it is resting on, and otherwise stay in mouse-look.
                if (player.locked) {
                    const target = crosshairTarget();
                    if (target) target.click();
                    return;
                }
                if (eventHitsScreen(event)) return;
                lockPointer();
            });
            layer.addEventListener("contextmenu", (event) => {
                if (eventHitsScreen(event)) return;
                event.preventDefault();
                if (event.target.closest(".room-exit")) return;
                lockPointer();
            });

            // Clicks and hover resolve through the CSS3D projection, but wheel events are
            // routed by a compositor hit test that ignores it, so they never reach the
            // scroller on the monitor. elementFromPoint does follow the projection, so use
            // it to find the real scroller and drive it directly.
            function scrollableUnder(clientX, clientY) {
                let el = document.elementFromPoint(clientX, clientY);
                if (!el || !overlay.contains(el)) return null;
                while (el && el !== overlay) {
                    const overflowY = getComputedStyle(el).overflowY;
                    if ((overflowY === "auto" || overflowY === "scroll") &&
                        el.scrollHeight > el.clientHeight + 1) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return null;
            }

            layer.addEventListener("wheel", (event) => {
                if (!player.playing || player.animating) return;
                // Under pointer lock clientX/Y are frozen wherever the cursor was, so the
                // crosshair is the pointer -- same rule the click path uses. Without this
                // you could click a link while walking but never scroll the page.
                let x = event.clientX;
                let y = event.clientY;
                if (player.locked) {
                    const rect = layer.getBoundingClientRect();
                    x = rect.left + rect.width / 2;
                    y = rect.top + rect.height / 2;
                }
                const target = scrollableUnder(x, y);
                if (!target) return;
                target.scrollTop += event.deltaY;
                event.preventDefault();
            }, { passive: false });
            document.addEventListener("pointerlockchange", onPointerLock);
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("keydown", (event) => {
                if (!document.body.classList.contains("room-active")) return;
                keys[event.code] = true;
                if (!event.repeat) {
                    // Every key clicks, from the keyboard; the board's keys are the visitor's
                    // only while they sit at it (walking, they move the player).
                    heard[event.code] = true;
                    keySound.play(event.code, true);
                    if (player.sitting) room.keyboard.hold(event.code, true);
                }
                // On foot with the cursor free (after Esc, say), the first movement key is the
                // gesture that catches the mouse again, so no click is needed to look around.
                if (!event.repeat && player.playing && !player.sitting && !player.animating && !touch.enabled &&
                    !player.locked && !blackHole &&
                    ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
                    requestLook();
                }
                if (event.code === "Escape") {
                    if (player.locked) return;
                    event.preventDefault();
                    // Seated, Esc steps back (leaning back, then standing); on foot it leaves.
                    if (!lean(false)) exitRoom();
                }
                // E sits down at the chair. In the chair every letter is a key of the board, so
                // the camera keys are the arrows and Page Up and Down, as the game's are its own
                // camera keys: up leans in, down leans back (and from leaning back, stands up).
                if (event.code === "KeyE" && player.playing && !player.animating && !player.sitting && lookingAtChair()) {
                    event.preventDefault();
                    sitDown();
                }
                if (!event.repeat && (event.code === "ArrowUp" || event.code === "PageUp") && lean(true)) {
                    event.preventDefault();
                }
                if (!event.repeat && (event.code === "ArrowDown" || event.code === "PageDown") && lean(false)) {
                    event.preventDefault();
                }
                if (player.locked && ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
                    event.preventDefault();
                }
            });
            document.addEventListener("keyup", (event) => {
                keys[event.code] = false;
                if (room) room.keyboard.hold(event.code, false);
                if (heard[event.code]) {
                    heard[event.code] = false;
                    keySound.play(event.code, false);
                }
            });
            window.addEventListener("blur", releaseKeys);
            window.addEventListener("resize", () => {
                if (!room || !document.body.classList.contains("room-active")) return;
                room.resize();
                if (blackHole) {
                    const size = new THREE.Vector2();
                    room.renderer.getSize(size);
                    const dpr = room.renderer.getPixelRatio();
                    blackHole.target.setSize(
                        Math.max(1, Math.floor(size.x * dpr)),
                        Math.max(1, Math.floor(size.y * dpr))
                    );
                    blackHole.material.uniforms.u_aspect.value =
                        Math.max(size.x, 1) / Math.max(size.y, 1);
                    blackHole.material.uniforms.u_px.value = 1 / blackHole.target.height;
                }
                if (player.sitting && !move && !blackHole) {
                    // The poses depend on the view's shape, so the chair's is made again.
                    pose = seatPose(posture);
                    applyPose();
                }
                layoutMonitorHtml(room.screen.w, room.screen.h);
                markRender();
            });
        })();
