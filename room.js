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
            const jumpBtn = document.getElementById("touch-jump");
            // "USE / STAND" -- sit at the desk. Distinct from the mode button below.
            const deskBtn = document.getElementById("touch-desk");
            const glCanvas = document.getElementById("room-gl");
            const overlay = document.getElementById("monitor-overlay");
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

            if (!enterBtn || !layer) return;

            // HTML-in-Canvas (chrome://flags/#canvas-draw-element). When present, the page
            // can be captured into a real GPU texture, so the screen sits *inside* the
            // scene -- depth-tested, occluded by the bezel and the room -- instead of
            // floating above the WebGL canvas as a CSS3D overlay. The texture cannot
            // receive input, so it is used for the look-around pose only and we hand back
            // to the live CSS3D page the moment the pointer is free. Everywhere else this
            // is simply absent and the CSS3D path is the whole story.
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
                "vendor/CSS3DRenderer.js",
                "vendor/GLTFLoader.js"
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
                const startPrefetch = () => {
                    ensureRoomLibs().catch(() => {});
                };
                if (window.requestIdleCallback) {
                    window.requestIdleCallback(startPrefetch, { timeout: 1200 });
                } else {
                    window.addEventListener("load", startPrefetch, { once: true });
                }
            }

            let room = null;

            function cssColor(name) {
                return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
            }

            // Every surface is derived from the two theme colours, so the room re-skins with
            // the page instead of carrying its own hardcoded palette. mix = how far the
            // surface sits from --bg toward --fg; spec/shininess give each material a
            // distinct response to light so the shapes read as different stuff.
            // Specular is kept deliberately low across the board. Phong's highlight lobe on
            // a large flat panel viewed up close (the bezel, seen from the chair) turns
            // into a broad bright smear rather than a highlight, so these read as matte
            // surfaces with just enough sheen to separate metal from plastic from paint.
            // Two colours in this room and no others: the greyscale between --bg and --fg,
            // and the theme's own accent (pure red on modus-vivendi, pure blue on
            // modus-operandi). mix is how far the grey sits from --bg toward --fg; tint is
            // how much accent is stirred in. Nothing invents a hue of its own.
            const SURFACES = {
                wall:    { mix: 0.11, shininess: 2,  spec: 0.01, tint: 0.015 },
                floor:   { mix: 0.16, shininess: 10, spec: 0.03, tint: 0.020 },
                ceiling: { mix: 0.06, shininess: 1,  spec: 0.01, tint: 0.010 },
                skirt:   { mix: 0.22, shininess: 8,  spec: 0.03, tint: 0.020 },
                trim:    { mix: 0.26, shininess: 12, spec: 0.04, tint: 0.020 },
                door:    { mix: 0.20, shininess: 20, spec: 0.05, tint: 0.045 },
                doorTrim:{ mix: 0.29, shininess: 14, spec: 0.05, tint: 0.035 },
                bezel:   { mix: 0.31, shininess: 16, spec: 0.05, tint: 0.015 },
                deskTop: { mix: 0.27, shininess: 14, spec: 0.05, tint: 0.025 },
                metal:   { mix: 0.46, shininess: 34, spec: 0.14, tint: 0.020 },
                keycap:  { mix: 0.24, shininess: 6,  spec: 0.03, tint: 0.015 },
                // The few things allowed to actually read as coloured.
                rug:     { mix: 0.15, shininess: 1,  spec: 0.00, tint: 0.30 },
                plant:   { mix: 0.34, shininess: 14, spec: 0.05, tint: 0.09 },
                pot:     { mix: 0.24, shininess: 8,  spec: 0.03, tint: 0.07 },
                paper:   { mix: 0.56, shininess: 4,  spec: 0.02, tint: 0.010 }
            };

            function roomPalette() {
                const bg = cssColor("--bg");
                const fg = cssColor("--fg");
                const accent = cssColor("--cube-color");
                const out = { bg: bg, accent: accent };
                for (const key in SURFACES) {
                    const surface = SURFACES[key];
                    const base = bg.clone().lerp(fg, surface.mix);
                    out[key] = surface.tint ? base.lerp(accent, surface.tint) : base;
                }
                return out;
            }

            function makeMats(palette) {
                const mats = {};
                for (const key in SURFACES) {
                    mats[key] = new THREE.MeshPhongMaterial({
                        color: palette[key],
                        shininess: SURFACES[key].shininess,
                        specular: new THREE.Color().setScalar(SURFACES[key].spec)
                    });
                }
                return mats;
            }

            function applyPalette(r) {
                const p = roomPalette();
                for (const key in SURFACES) {
                    if (r.mats[key]) r.mats[key].color.copy(p[key]);
                }
                if (r.panelMat) {
                    r.panelMat.color.copy(p.paper);
                    r.panelMat.emissive.copy(p.paper);
                }
                if (r.screenLight) r.screenLight.color.copy(p.accent);
                const white = new THREE.Color(0xffffff);
                if (r.leafMat) r.leafMat.color.copy(p.plant);
                if (r.doorGlowMat) r.doorGlowMat.color.copy(p.accent).lerp(white, 0.30);
                if (r.stripMat) r.stripMat.color.copy(p.accent).lerp(new THREE.Color(0xffffff), 0.30);
                r.scene.background = p.bg;
                r.renderer.setClearColor(p.bg, 1);
            }

            function createRoom() {
                if (typeof THREE === "undefined") {
                    throw new Error("three.js unavailable");
                }

                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 80);
                const palette = roomPalette();
                scene.background = palette.bg;

                // Phones get a smaller shadow map, but they must NOT get a lower pixel
                // ratio -- a phone is typically 3x density, so clamping to 1 was rendering
                // a third-resolution image and stretching it over the screen.
                const lowPower = isTouchDevice();
                // Above 2x device pixels the backing store is already doing the job MSAA
                // would; paying for both is most of why phones struggled.
                const denseScreen = (window.devicePixelRatio || 1) >= 2;
                const renderer = new THREE.WebGLRenderer({
                    canvas: glCanvas,
                    antialias: !denseScreen,
                    alpha: false,
                    powerPreference: "high-performance"
                });
                renderer.setClearColor(palette.bg, 1);
                renderer.autoClear = true;
                renderer.shadowMap.enabled = true;
                renderer.shadowMap.type = THREE.PCFSoftShadowMap;
                maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
                glCanvas.style.position = "absolute";
                glCanvas.style.inset = "0";
                glCanvas.style.pointerEvents = "none";

                const mats = makeMats(palette);
                const panelMat = new THREE.MeshPhongMaterial({
                    color: palette.paper,
                    emissive: palette.paper,
                    emissiveIntensity: 0.85,
                    shininess: 4
                });

                const HALF = 5;
                const HEIGHT = 3.2;
                const WALL = 0.16;

                function box(w, h, d, mat, x, y, z, parent) {
                    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
                    mesh.position.set(x, y, z);
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    (parent || scene).add(mesh);
                    return mesh;
                }

                // The shell receives light but must not cast: it encloses the camera, so
                // casting would drop the whole room into its own shadow.
                [
                    box(HALF * 2 + WALL, WALL, HALF * 2 + WALL, mats.floor, 0, -WALL / 2, 0),
                    box(HALF * 2 + WALL, WALL, HALF * 2 + WALL, mats.ceiling, 0, HEIGHT + WALL / 2, 0),
                    box(HALF * 2 + WALL, HEIGHT, WALL, mats.wall, 0, HEIGHT / 2, -HALF),
                    box(HALF * 2 + WALL, HEIGHT, WALL, mats.wall, 0, HEIGHT / 2, HALF),
                    box(WALL, HEIGHT, HALF * 2, mats.wall, -HALF, HEIGHT / 2, 0),
                    box(WALL, HEIGHT, HALF * 2, mats.wall, HALF, HEIGHT / 2, 0)
                ].forEach((mesh) => { mesh.castShadow = false; });

                const SKIRT_H = 0.13;
                const SKIRT_D = 0.028;
                const inner = HALF - WALL / 2;
                box(HALF * 2, SKIRT_H, SKIRT_D, mats.skirt, 0, SKIRT_H / 2, -inner + SKIRT_D / 2);
                box(HALF * 2, SKIRT_H, SKIRT_D, mats.skirt, 0, SKIRT_H / 2, inner - SKIRT_D / 2);
                box(SKIRT_D, SKIRT_H, HALF * 2, mats.skirt, -inner + SKIRT_D / 2, SKIRT_H / 2, 0);
                box(SKIRT_D, SKIRT_H, HALF * 2, mats.skirt, inner - SKIRT_D / 2, SKIRT_H / 2, 0);

                const ceilingPanel = box(1.7, 0.05, 0.52, panelMat, 0, HEIGHT - 0.025, 0.3);
                ceilingPanel.castShadow = false;
                box(1.82, 0.04, 0.62, mats.trim, 0, HEIGHT - 0.015, 0.3).castShadow = false;

                // -- door -------------------------------------------------------------
                // A real six-panel door: stiles and rails left as the slab, each panel sunk
                // with a bevelled surround and a raised centre field, so the light actually
                // catches the mouldings instead of drawing two flat rectangles.
                const doorW = 1.06;
                const doorH = 2.15;
                const doorZ = HALF - WALL / 2;
                const doorFace = doorZ - 0.075;      // front face of the slab, into the room
                const doorGroup = new THREE.Group();
                scene.add(doorGroup);

                // Architrave: two stepped depths read as moulding rather than a flat band.
                const casingOuter = 0.13;
                const casingInner = 0.075;
                [[-1, 0], [1, 0]].forEach(([side]) => {
                    const x = side * (doorW / 2 + casingOuter / 2);
                    box(casingOuter, doorH + casingOuter, 0.055, mats.doorTrim, x, (doorH + casingOuter) / 2, doorZ - 0.030, doorGroup);
                    box(casingInner, doorH + casingInner, 0.075, mats.doorTrim, side * (doorW / 2 + casingInner / 2), (doorH + casingInner) / 2, doorZ - 0.048, doorGroup);
                });
                box(doorW + casingOuter * 2, casingOuter, 0.055, mats.doorTrim, 0, doorH + casingOuter / 2, doorZ - 0.030, doorGroup);
                box(doorW + casingInner * 2, casingInner, 0.075, mats.doorTrim, 0, doorH + casingInner / 2, doorZ - 0.048, doorGroup);

                // Reveal behind the slab, so the opening reads as depth not a painted-on door.
                box(doorW, doorH, 0.02, mats.doorTrim, 0, doorH / 2, doorZ - 0.012, doorGroup).castShadow = false;

                const slab = box(doorW, doorH, 0.048, mats.door, 0, doorH / 2, doorFace, doorGroup);
                slab.castShadow = true;

                // Six panels: two short at the bottom, two tall in the middle, two at the top.
                const stile = 0.115;                 // vertical frame width
                const midRail = 0.10;
                const panelW = (doorW - stile * 3) / 2;
                const PANELS = [
                    { y: 0.40, h: 0.62 },
                    { y: 1.16, h: 0.72 },
                    { y: 1.83, h: 0.42 }
                ];
                PANELS.forEach((row) => {
                    [-1, 1].forEach((side) => {
                        const x = side * (panelW / 2 + stile / 2);
                        // sunken surround
                        box(panelW, row.h, 0.016, mats.doorTrim, x, row.y, doorFace - 0.020, doorGroup)
                            .castShadow = false;
                        // raised centre field, inset by the moulding
                        box(panelW - 0.075, row.h - 0.075, 0.020, mats.door, x, row.y, doorFace - 0.012, doorGroup)
                            .castShadow = false;
                    });
                });
                void midRail;

                // Three barrel hinges down the hanging stile.
                [0.32, doorH / 2, doorH - 0.32].forEach((y) => {
                    const hinge = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.017, 0.017, 0.10, 12),
                        mats.metal
                    );
                    hinge.position.set(-doorW / 2 - 0.004, y, doorFace + 0.004);
                    hinge.castShadow = true;
                    doorGroup.add(hinge);
                });

                // Lever handle on a round rose, plus an escutcheon below it.
                const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.014, 22), mats.metal);
                rose.rotation.x = Math.PI / 2;
                rose.position.set(doorW / 2 - 0.145, 1.045, doorFace - 0.028);
                rose.castShadow = true;
                doorGroup.add(rose);
                const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.055, 14), mats.metal);
                spindle.rotation.x = Math.PI / 2;
                spindle.position.set(doorW / 2 - 0.145, 1.045, doorFace - 0.052);
                doorGroup.add(spindle);
                const lever = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.024, 0.026), mats.metal);
                lever.position.set(doorW / 2 - 0.205, 1.045, doorFace - 0.070);
                lever.castShadow = true;
                doorGroup.add(lever);
                const leverTip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 10), mats.metal);
                leverTip.position.set(doorW / 2 - 0.266, 1.043, doorFace - 0.070);
                doorGroup.add(leverTip);
                const escutcheon = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.010, 16), mats.metal);
                escutcheon.rotation.x = Math.PI / 2;
                escutcheon.position.set(doorW / 2 - 0.145, 0.905, doorFace - 0.026);
                doorGroup.add(escutcheon);

                // Threshold, and the sliver of light from whatever is on the other side.
                box(doorW + 0.02, 0.014, 0.09, mats.doorTrim, 0, 0.007, doorZ - 0.05, doorGroup).castShadow = false;
                const doorGlowMat = new THREE.MeshBasicMaterial({
                    color: palette.accent.clone().lerp(new THREE.Color(0xffffff), 0.30),
                    transparent: true,
                    opacity: 0.85
                });
                const doorGlow = box(doorW - 0.06, 0.012, 0.16, doorGlowMat, 0, 0.008, doorZ - 0.115, doorGroup);
                doorGlow.castShadow = false;
                doorGlow.receiveShadow = false;

                function meshBox(w, h, d, mat, x, y, z, parent, rotX) {
                    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
                    mesh.position.set(x, y, z);
                    if (rotX) mesh.rotation.x = rotX;
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    (parent || scene).add(mesh);
                    return mesh;
                }

                const deskY = 0.74;
                const deskZ = -HALF + 0.66;
                const deskW = 1.88;
                const deskD = 0.80;
                const topT = 0.042;
                const deskTop = deskY + topT / 2;
                box(deskW, topT, deskD, mats.deskTop, 0, deskY, deskZ);
                box(deskW - 0.06, 0.016, deskD - 0.06, mats.trim, 0, deskY - topT / 2 - 0.008, deskZ).castShadow = false;
                const legX = deskW / 2 - 0.08;
                const legZBack = deskZ - deskD / 2 + 0.08;
                const legZFront = deskZ + deskD / 2 - 0.08;
                [[-legX, legZBack], [legX, legZBack], [-legX, legZFront], [legX, legZFront]].forEach(([lx, lz]) => {
                    box(0.045, deskY - topT / 2, 0.045, mats.metal, lx, (deskY - topT / 2) / 2, lz);
                });
                box(deskW - 0.16, 0.028, 0.028, mats.metal, 0, 0.09, legZBack);
                box(deskW - 0.16, 0.028, 0.028, mats.metal, 0, 0.09, legZFront);
                box(deskW - 0.30, 0.32, 0.024, mats.deskTop, 0, deskY - 0.28, deskZ - deskD / 2 + 0.07);

                // Monitor. screenW/screenH/screenY/frontZ define the CSS3D plane, so they
                // stay put -- only the hardware around them changed.
                const screenW = 0.80;
                const screenH = 0.45;
                const bezel = 0.016;
                const screenY = deskY + 0.44;
                const frontZ = deskZ - 0.07;
                const outerW = screenW + bezel * 2;
                const outerH = screenH + bezel * 2;
                // The neck has to reach the panel. It used to be sized to stop 0.03 short of
                // the panel's bottom edge, which left the screen floating above its own
                // stand; both ends are now derived from what they actually meet, with a
                // little overlap at each joint so no seam can open up.
                const panelBottom = screenY - outerH / 2;
                const neckBottom = deskTop + 0.016;          // just inside the foot
                const neckTop = panelBottom + 0.030;         // buried into the panel
                const neckH = Math.max(neckTop - neckBottom, 0.06);
                const monitorProxy = [
                    box(outerW, outerH, 0.016, mats.bezel, 0, screenY, frontZ - 0.008),
                    box(outerW * 0.90, outerH * 0.82, 0.042, mats.bezel, 0, screenY, frontZ - 0.037),
                    // Hinge housing straddling the joint, not floating up inside the panel.
                    box(0.185, 0.075, 0.036, mats.bezel, 0, panelBottom + 0.014, frontZ - 0.055),
                    box(0.072, neckH, 0.040, mats.metal, 0, neckBottom + neckH / 2, frontZ - 0.055)
                ];
                const monitorFoot = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.185, 0.020, 30), mats.metal);
                monitorFoot.position.set(0, deskTop + 0.010, frontZ - 0.055);
                monitorFoot.castShadow = true;
                monitorFoot.receiveShadow = true;
                scene.add(monitorFoot);
                monitorProxy.push(monitorFoot);

                // Desk props: they sell the scale of the room more than the room does.

                // Keyboard: a real 60% layout with individual keycaps. Unit widths per row
                // each sum to 15u, which is what gives the staggered edges a keyboard reads
                // by. All 61 caps live in one InstancedMesh, so they cost a single draw call.
                const KB_W = 0.40;
                const KB_D = 0.142;
                const KB_PAD = 0.009;
                const KB_UNITS = 15;
                const KB_ROWS = [
                    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
                    [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5],
                    [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25],
                    [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.75],
                    [1.25, 1.25, 1.25, 6.25, 1.25, 1.25, 1.25, 1.25]
                ];

                const kbGroup = new THREE.Group();
                kbGroup.position.set(0, deskTop, deskZ + 0.215);
                kbGroup.rotation.x = -0.05;
                scene.add(kbGroup);
                box(KB_W, 0.012, KB_D, mats.keycap, 0, 0.006, 0, kbGroup);
                box(KB_W - 0.013, 0.005, KB_D - 0.013, mats.bezel, 0, 0.0135, 0, kbGroup)
                    .castShadow = false;

                const kbUnit = (KB_W - KB_PAD * 2) / KB_UNITS;
                const kbRowD = (KB_D - KB_PAD * 2) / KB_ROWS.length;
                const capCount = KB_ROWS.reduce((total, row) => total + row.length, 0);
                const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mats.bezel, capCount);
                caps.castShadow = true;
                caps.receiveShadow = true;
                const capMatrix = new THREE.Matrix4();
                const capPos = new THREE.Vector3();
                const capScale = new THREE.Vector3();
                const capQuat = new THREE.Quaternion();
                let capIndex = 0;
                KB_ROWS.forEach((row, rowIndex) => {
                    let x = -KB_W / 2 + KB_PAD;
                    const z = -KB_D / 2 + KB_PAD + kbRowD * (rowIndex + 0.5);
                    row.forEach((widthInUnits) => {
                        const capW = kbUnit * widthInUnits;
                        capPos.set(x + capW / 2, 0.0185, z);
                        capScale.set(capW - kbUnit * 0.13, 0.008, kbRowD * 0.78);
                        capMatrix.compose(capPos, capQuat, capScale);
                        caps.setMatrixAt(capIndex, capMatrix);
                        capIndex += 1;
                        x += capW;
                    });
                });
                caps.instanceMatrix.needsUpdate = true;
                kbGroup.add(caps);

                // Mug: a lathed profile, so it is genuinely hollow -- outer wall, rim, inner
                // wall, inner floor -- instead of a capped cylinder. The inner surface is
                // only visible because the profile doubles back, hence DoubleSide.
                mats.paper.side = THREE.DoubleSide;
                const MUG_PROFILE = [
                    [0.000, 0.000], [0.036, 0.000], [0.038, 0.004], [0.040, 0.030],
                    [0.041, 0.072], [0.041, 0.087], [0.037, 0.088], [0.036, 0.070],
                    [0.035, 0.013], [0.000, 0.012]
                ].map((p) => new THREE.Vector2(p[0], p[1]));

                const mugGroup = new THREE.Group();
                mugGroup.position.set(0.40, deskTop, deskZ + 0.20);
                mugGroup.rotation.y = 0.12;
                scene.add(mugGroup);
                const mug = new THREE.Mesh(new THREE.LatheGeometry(MUG_PROFILE, 40), mats.paper);
                mug.castShadow = true;
                mug.receiveShadow = true;
                mugGroup.add(mug);

                // Open arc rather than a closed ring, rotated so its two ends meet the wall.
                const mugHandle = new THREE.Mesh(
                    new THREE.TorusGeometry(0.023, 0.0055, 10, 30, Math.PI * 1.35),
                    mats.paper
                );
                mugHandle.position.set(0.052, 0.050, 0);
                mugHandle.rotation.z = -2.12;
                mugHandle.castShadow = true;
                mugGroup.add(mugHandle);

                const brew = new THREE.Mesh(
                    new THREE.CircleGeometry(0.0345, 32),
                    new THREE.MeshPhongMaterial({
                        // Brewed tea is nearly black in a mug; it only looks amber held up
                        // to the light. The sheen is what reads as liquid, not the colour.
                        color: 0x1d1108,
                        shininess: 90,
                        specular: new THREE.Color().setScalar(0.26)
                    })
                );
                brew.rotation.x = -Math.PI / 2;
                brew.position.y = 0.071;
                mugGroup.add(brew);

                // "Tea", printed on the side. A thin cylinder segment hugging the outer
                // wall carries it, so the word curves with the mug instead of floating flat.
                const labelCanvas = document.createElement("canvas");
                labelCanvas.width = 256;
                labelCanvas.height = 128;
                const labelCtx = labelCanvas.getContext("2d");
                labelCtx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
                labelCtx.fillStyle = "#21211f";
                labelCtx.font = "700 74px 'IBM Plex Mono', ui-monospace, monospace";
                labelCtx.textAlign = "center";
                labelCtx.textBaseline = "middle";
                labelCtx.fillText("Tea", labelCanvas.width / 2, labelCanvas.height / 2 + 4);
                const labelTexture = new THREE.CanvasTexture(labelCanvas);
                labelTexture.anisotropy = maxAnisotropy;

                const mugLabel = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.0418, 0.0412, 0.036, 32, 1, true, -0.52, 1.04),
                    new THREE.MeshPhongMaterial({
                        map: labelTexture,
                        transparent: true,
                        shininess: 10,
                        side: THREE.DoubleSide,
                        depthWrite: false
                    })
                );
                mugLabel.position.y = 0.052;
                mugGroup.add(mugLabel);

                const rug = box(2.6, 0.010, 1.9, mats.rug, 0, 0.005, deskZ + 1.25);
                rug.castShadow = false;
                // Woven border, so the rug reads as a rug and not a painted rectangle.
                box(2.42, 0.012, 1.72, mats.floor, 0, 0.006, deskZ + 1.25).castShadow = false;

                // A strip under the desk lip: cheap to draw, and it puts colour on the floor.
                const stripMat = new THREE.MeshBasicMaterial({
                    color: palette.accent.clone().lerp(new THREE.Color(0xffffff), 0.30),
                    transparent: true,
                    opacity: 0.75
                });
                const deskStrip = box(deskW - 0.22, 0.010, 0.014, stripMat, 0,
                    deskY - topT / 2 - 0.026, deskZ + deskD / 2 - 0.05);
                deskStrip.castShadow = false;
                deskStrip.receiveShadow = false;

                // Something alive in the corner. Cones read as spikes; a real blade is a
                // flat tapered shape with a spine, so each leaf is an outline swept from a
                // bezier and bent along its length.
                const plantX = -HALF + 0.74;
                const plantZ = HALF - 1.10;

                const potProfile = [
                    [0.000, 0.000], [0.098, 0.000], [0.112, 0.018], [0.150, 0.240],
                    [0.162, 0.272], [0.170, 0.300], [0.156, 0.302], [0.148, 0.276],
                    [0.136, 0.244], [0.100, 0.026], [0.000, 0.024]
                ].map((pt) => new THREE.Vector2(pt[0], pt[1]));
                const pot = new THREE.Mesh(new THREE.LatheGeometry(potProfile, 32), mats.pot);
                pot.position.set(plantX, 0, plantZ);
                pot.castShadow = true;
                pot.receiveShadow = true;
                scene.add(pot);
                const soil = new THREE.Mesh(new THREE.CircleGeometry(0.132, 26), mats.skirt);
                soil.rotation.x = -Math.PI / 2;
                soil.position.set(plantX, 0.268, plantZ);
                scene.add(soil);

                // One blade: widest a third of the way up, drawn to a point.
                function bladeGeometry(length, width) {
                    const shape = new THREE.Shape();
                    shape.moveTo(0, 0);
                    shape.bezierCurveTo(width * 0.9, length * 0.18, width, length * 0.52, 0, length);
                    shape.bezierCurveTo(-width, length * 0.52, -width * 0.9, length * 0.18, 0, 0);
                    const geo = new THREE.ShapeGeometry(shape, 14);
                    // Bend it back along its own length so it arches instead of standing flat.
                    const pos = geo.attributes.position;
                    for (let i = 0; i < pos.count; i++) {
                        const y = pos.getY(i);
                        const t = Math.min(Math.max(y / length, 0), 1);
                        pos.setZ(i, -Math.pow(t, 1.9) * length * 0.34);
                        pos.setY(i, y * (1 - Math.pow(t, 2.4) * 0.16));
                    }
                    geo.computeVertexNormals();
                    return geo;
                }

                const bladeSizes = [
                    { l: 0.74, w: 0.062 }, { l: 0.62, w: 0.055 },
                    { l: 0.50, w: 0.048 }, { l: 0.38, w: 0.042 }
                ];
                const blades = bladeSizes.map((b) => bladeGeometry(b.l, b.w));
                const leafMat = new THREE.MeshPhongMaterial({
                    color: palette.plant,
                    shininess: SURFACES.plant.shininess,
                    specular: new THREE.Color().setScalar(SURFACES.plant.spec),
                    side: THREE.DoubleSide
                });
                for (let i = 0; i < 11; i++) {
                    const geo = blades[i % blades.length];
                    const leaf = new THREE.Mesh(geo, leafMat);
                    const around = (i * 2.399) % (Math.PI * 2);   // golden angle, no clumping
                    const lean = 0.16 + (i % 4) * 0.11;
                    leaf.position.set(
                        plantX + Math.cos(around) * 0.030,
                        0.262,
                        plantZ + Math.sin(around) * 0.030
                    );
                    leaf.rotation.set(0, -around, 0);
                    leaf.rotateX(-lean);
                    leaf.rotateZ((i % 2 ? 1 : -1) * 0.12);
                    leaf.castShadow = true;
                    scene.add(leaf);
                }

                const screenGlass = new THREE.Mesh(
                    new THREE.PlaneGeometry(1, 1),
                    new THREE.MeshBasicMaterial({
                        color: 0x0a0a0a,
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
                const chairGroup = new THREE.Group();
                chairGroup.position.set(chairX, 0, chairZ);
                scene.add(chairGroup);
                // The box-stack stand-in that used to sit here is gone -- chair.glb is
                // committed and is the only chair now, so nothing placeholder ships.
                const chairProxy = [];

                scene.add(new THREE.AmbientLight(0xffffff, 0.34));
                scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 0.46));

                const sun = new THREE.DirectionalLight(0xffffff, 0.52);
                sun.position.set(2.0, 3.6, 2.4);
                sun.target.position.set(0, 0.7, deskZ);
                sun.castShadow = true;
                // Everything worth shadowing lives around the desk, so the shadow camera is
                // cropped to that instead of the whole 10m room. Combined with the larger
                // map this is roughly 8x the texel density on the furniture, which is what
                // turns the blocky blob under the monitor into an actual soft shadow.
                sun.shadow.mapSize.set(lowPower ? 1024 : 2048, lowPower ? 1024 : 2048);
                sun.shadow.camera.near = 0.5;
                sun.shadow.camera.far = 14;
                sun.shadow.camera.left = -2.6;
                sun.shadow.camera.right = 2.6;
                sun.shadow.camera.top = 3.0;
                sun.shadow.camera.bottom = -1.2;
                sun.shadow.bias = -0.0006;
                sun.shadow.normalBias = 0.022;
                sun.shadow.radius = 2.5;
                // Nothing in this room moves except the camera, and a shadow map does not
                // depend on the camera. Render it once instead of every frame; anything
                // that does change the scene (the chair arriving) asks for a refresh.
                sun.shadow.autoUpdate = false;
                sun.shadow.needsUpdate = true;
                scene.add(sun);
                scene.add(sun.target);

                const ceilingLight = new THREE.PointLight(0xffffff, 0.34, 11, 2);
                ceilingLight.position.set(0, HEIGHT - 0.30, 0.3);
                scene.add(ceilingLight);

                // Spill from the monitor, tinted with the theme accent. Kept deliberately
                // weak and short-range -- it is a hint of glow, not a coloured floodlight.
                const screenLight = new THREE.PointLight(palette.accent, 0.12, 1.2, 2);
                screenLight.position.set(0, screenY, frontZ + 0.26);
                scene.add(screenLight);

                overlay.classList.add("monitor-html");

                if (typeof THREE.CSS3DRenderer === "undefined") {
                    throw new Error("CSS3DRenderer unavailable");
                }
                const cssRenderer = new THREE.CSS3DRenderer();
                cssRenderer.domElement.id = "room-css";
                cssRenderer.domElement.style.position = "absolute";
                cssRenderer.domElement.style.inset = "0";
                cssRenderer.domElement.style.pointerEvents = "none";
                const hudEl = document.getElementById("room-hud");
                layer.insertBefore(cssRenderer.domElement, hudEl);
                const cssScene = new THREE.Scene();
                const cssObject = new THREE.CSS3DObject(overlay);
                cssScene.add(cssObject);

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
                    cssRenderer.setSize(w, h);
                }

                const roomState = {
                    scene,
                    camera,
                    renderer,
                    cssRenderer,
                    cssScene,
                    cssObject,
                    mount: overlay,
                    appHome: null,
                    htmlSurface: HTML_CANVAS_SUPPORTED
                        ? createHtmlSurface(STAGE_W, STAGE_H)
                        : createBakeSurface(SCREEN_CSS_W, SCREEN_CSS_H),
                    screenMode: "dom",
                    mats,
                    panelMat,
                    sun,
                    screenLight,
                    leafMat,
                    doorGlowMat,
                    stripMat,
                    screenGlass,
                    screenMesh: null,
                    monitorProxy,
                    chairGroup,
                    chairProxy,
                    deskY,
                    deskZ,
                    chairX,
                    chairZ,
                    chairRotY,
                    screen: { x: 0, y: screenY, z: screenZ, w: screenW, h: screenH },
                    // top = the height you stand on when you land on it. Without it these
                    // were infinitely tall walls: solid from every side and impossible to
                    // get on top of.
                    obstacles: [
                        { minX: -deskW / 2 - 0.02, maxX: deskW / 2 + 0.02,
                          minZ: deskZ - deskD / 2, maxZ: deskZ + deskD / 2, top: deskY + topT / 2 },
                        { minX: chairX - 0.16, maxX: chairX + 0.16,
                          minZ: chairZ - 0.18, maxZ: chairZ + 0.20, top: 0.52 },
                        { minX: plantX - 0.17, maxX: plantX + 0.17,
                          minZ: plantZ - 0.17, maxZ: plantZ + 0.17, top: 0.30 }
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
            // phones). CSS3D looks fine head-on but drifts off the bezel at an angle on
            // mobile, so look mode bakes .app into a real texture that depth-tests with
            // the room. The live CSS3D page comes back the moment look mode ends.
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
                let bakeGen = 0;

                function pageCss() {
                    return Array.prototype.map.call(
                        document.querySelectorAll("style"),
                        (node) => node.textContent || ""
                    ).join("\n").replace(/body\.room-active/g, ".room-bake");
                }

                function bake(app) {
                    if (!app || baking) return;
                    baking = true;
                    const gen = ++bakeGen;
                    const w = app.offsetWidth || room.htmlW || width;
                    const h = app.offsetHeight || room.htmlH || height;
                    const theme = document.documentElement.dataset.theme || "modus-vivendi";
                    const bg = getComputedStyle(document.documentElement)
                        .getPropertyValue("--bg").trim() || "#000";
                    const css = pageCss();
                    const markup = new XMLSerializer().serializeToString(app);
                    const svg = [
                        '<svg xmlns="http://www.w3.org/2000/svg" width="', w, '" height="', h, '">',
                        '<foreignObject width="100%" height="100%">',
                        '<div xmlns="http://www.w3.org/1999/xhtml" class="room-bake" data-theme="', theme, '"',
                        ' style="width:', w, 'px;height:', h, 'px;background:', bg, ';overflow:hidden">',
                                                // The whole SVG is parsed as XML, so a bare & anywhere in it is a
                        // fatal entity error -- which silently became img.onerror and a
                        // blank screen. (SVG-in-img blocks external loads anyway, so this
                        // import never fetches; it just has to not break the parse.)
                        '<style>@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&amp;display=swap");',
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
                    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
                    img.onload = function () {
                        URL.revokeObjectURL && null;
                        if (gen !== bakeGen) {
                            baking = false;
                            return;
                        }
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.fillStyle = bg;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        dirty = true;
                        baking = false;
                        markRender();
                    };
                    img.onerror = function () {
                        baking = false;
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.fillStyle = bg;
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        dirty = true;
                        markRender();
                    };
                    img.src = url;
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
                            /* missing files are expected until a model is added */
                        }
                    }
                })();
            }

            function meshMaterials(node) {
                return node.material ? [].concat(node.material) : [];
            }

            function flattenToLambert(root) {
                root.traverse((node) => {
                    if (!node.isMesh) return;
                    node.castShadow = true;
                    node.receiveShadow = true;
                    // MeshLambertMaterial has no flatShading in three r128 -- asking for it
                    // only logs a warning. MeshPhongMaterial with shininess 0 matches the
                    // Lambert look and does support it.
                    const next = meshMaterials(node).map((mat) => new THREE.MeshPhongMaterial({
                        color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
                        shininess: 0,
                        flatShading: true
                    }));
                    node.material = next.length === 1 ? next[0] : next;
                });
            }

            function clearProxy(meshes, extra) {
                meshes.forEach((mesh) => {
                    if (mesh.parent) mesh.parent.remove(mesh);
                });
                meshes.length = 0;
                if (extra && extra.parent) extra.parent.remove(extra);
            }

            function standUpright(model) {
                model.updateMatrixWorld(true);
                const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
                if (size.z >= size.y && size.z >= size.x) model.rotation.x = -Math.PI / 2;
                else if (size.x >= size.y && size.x >= size.z) model.rotation.z = Math.PI / 2;
            }

            function installChairModel(roomState, model) {
                flattenToLambert(model);
                roomState.scene.add(model);
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
                const placed = new THREE.Box3().setFromObject(model);
                roomState.obstacles[1] = {
                    minX: placed.min.x + 0.05,
                    maxX: placed.max.x - 0.05,
                    minZ: placed.min.z + 0.05,
                    maxZ: placed.max.z - 0.05,
                    top: placed.max.y
                };
                clearProxy(roomState.chairProxy, roomState.chairGroup);
                if (roomState.sun) roomState.sun.shadow.needsUpdate = true;
            }

            const keys = Object.create(null);

            // A keyup that lands while the window is blurred (alt-tab, Esc out of the
            // room) never reaches us, which would leave the key stuck down.
            function releaseKeys() {
                for (const code in keys) keys[code] = false;
            }

            const player = {
                x: 0,
                y: 0,
                z: 3.6,
                vx: 0,
                vy: 0,
                vz: 0,
                yaw: 0,
                pitch: 0,
                onGround: true,
                locked: false,
                playing: false,
                animating: false,
                sitting: false,
                jumpLatched: false,
                standX: null,
                standZ: null
            };

            // Touch state, mirrored into the same movement code the keyboard feeds.
            const touch = {
                enabled: false,
                jump: false,
                stick: { active: false, sprint: false, x: 0, y: 0, id: -1, baseX: 0, baseY: 0 },
                look: { id: -1, lastX: 0, lastY: 0 }
            };

            const EYE = 1.58;
            const SIT_EYE = 1.18;
            const FOV_STAND = 52;
            const FOV_SIT = 46;
            const FOV_FILL = 70;
            const RADIUS = 0.24;

            // Half-Life 2 movement. Source measures in units where 1u = 3/4 inch, so every
            // cvar below is the stock HL2 value converted into the metres this room is
            // modelled in -- keeping the ratio of speed to room size identical is what
            // preserves the feel, not the raw numbers.
            const HU = 0.01905;                       // one Source unit, in metres
            const SPEED_WALK = 190 * HU;              // 3.62 m/s, hl2 ground speed
            const SPEED_SPRINT = 320 * HU;            // 6.10 m/s, sv_maxspeed with +speed
            const SV_ACCELERATE = 10;
            const SV_AIRACCELERATE = 10;
            const SV_FRICTION = 4;
            const SV_STOPSPEED = 100 * HU;            // 1.905 m/s
            const SV_GRAVITY = 600 * HU;              // 11.43 m/s^2
            const JUMP_IMPULSE = 268.3281573 * HU;    // sqrt(2 * 600 * 60) -> 5.11 m/s
            const AIR_SPEED_CAP = 30 * HU;            // what makes air-strafing possible

            // Source look: m_yaw/m_pitch are 0.022 deg per mouse count, scaled by
            // `sensitivity` (3 is the HL2 default).
            const LOOK_SENSITIVITY = 3;
            const LOOK_SCALE = LOOK_SENSITIVITY * 0.022 * Math.PI / 180;
            const PITCH_LIMIT = 89 * Math.PI / 180;
            const TOUCH_LOOK_SCALE = 0.0038;          // rad per css px, tuned for thumbs

            // Scratch vectors: these run on every frame, so they are reused rather than
            // reallocated.
            const tmpChair = new THREE.Vector3();
            const tmpToChair = new THREE.Vector3();
            const tmpForward = new THREE.Vector3();
            const tmpToCam = new THREE.Vector3();
            const tmpNormal = new THREE.Vector3();
            const lensCenter = new THREE.Vector3();

            // CGameMovement::Friction. The sv_stopspeed floor is the part that matters:
            // below it you shed speed at a constant rate instead of exponentially, which is
            // why Half-Life 2 stops crisply rather than gliding to a halt.
            function applyFriction(dt) {
                const speed = Math.hypot(player.vx, player.vz);
                if (speed < 0.008) {
                    player.vx = 0;
                    player.vz = 0;
                    return;
                }
                const control = speed < SV_STOPSPEED ? SV_STOPSPEED : speed;
                const scale = Math.max(0, speed - control * SV_FRICTION * dt) / speed;
                player.vx *= scale;
                player.vz *= scale;
            }

            // CGameMovement::Accelerate. Acceleration is projected onto the wish direction
            // and clamped so it never pushes past wishspeed *along that axis* -- speed
            // already carried perpendicular to it is left alone, which is the whole basis
            // of Source's air game.
            function accelerate(wishX, wishZ, wishSpeed, accel, dt) {
                const current = player.vx * wishX + player.vz * wishZ;
                const add = wishSpeed - current;
                if (add <= 0) return;
                const step = Math.min(accel * wishSpeed * dt, add);
                player.vx += step * wishX;
                player.vz += step * wishZ;
            }

            // CGameMovement::AirAccelerate: identical, except wishspeed is clipped to a very
            // small value first, so steering mid-jump is weak but never zero.
            function airAccelerate(wishX, wishZ, wishSpeed, dt) {
                const clipped = Math.min(wishSpeed, AIR_SPEED_CAP);
                const current = player.vx * wishX + player.vz * wishZ;
                const add = clipped - current;
                if (add <= 0) return;
                const step = Math.min(SV_AIRACCELERATE * wishSpeed * dt, add);
                player.vx += step * wishX;
                player.vz += step * wishZ;
            }

            // View bob and the landing dip. Source drives these off speed; they are a large
            // part of why walking in HL2 feels weighted rather than like a floating camera.
            const view = { bobTime: 0, bobY: 0, bobX: 0, roll: 0, dip: 0, impact: 0 };

            function updateViewBob(dt) {
                const speed = Math.hypot(player.vx, player.vz);
                if (player.onGround && speed > 0.25) {
                    const amp = Math.min(speed / SPEED_SPRINT, 1);
                    view.bobTime += dt * (3.6 + speed * 1.15);
                    view.bobY = Math.sin(view.bobTime * 2) * 0.021 * amp;
                    view.bobX = Math.sin(view.bobTime) * 0.014 * amp;
                    view.roll = Math.sin(view.bobTime) * 0.006 * amp;
                } else {
                    const settle = Math.min(1, dt * 9);
                    view.bobY -= view.bobY * settle;
                    view.bobX -= view.bobX * settle;
                    view.roll -= view.roll * settle;
                }
                if (view.impact > 0) {
                    view.dip = Math.min(view.dip + view.impact * 0.10, 0.085);
                    view.impact = 0;
                }
                view.dip -= view.dip * Math.min(1, dt * 7.5);
            }

            // What you are standing on at this spot: the tallest obstacle whose footprint
            // contains you, or the floor. Uses the player's centre rather than the collision
            // radius, so you cannot hover with your feet off the edge.
            function supportHeight(x, z) {
                let height = 0;
                room.obstacles.forEach((box) => {
                    if (box.top == null || box.top <= height) return;
                    if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ) {
                        height = box.top;
                    }
                });
                return height;
            }

            function collide(nx, nz, feetY) {
                const inner = room.HALF - 0.18 - RADIUS;
                nx = Math.max(-inner, Math.min(inner, nx));
                nz = Math.max(-inner, Math.min(inner, nz));
                room.obstacles.forEach((box) => {
                    // Once your feet clear the top, it stops being a wall and becomes a
                    // surface you can walk out over.
                    if (box.top != null && feetY >= box.top - 0.02) return;
                    if (nx > box.minX - RADIUS && nx < box.maxX + RADIUS && nz > box.minZ - RADIUS && nz < box.maxZ + RADIUS) {
                        const cx = (box.minX + box.maxX) / 2;
                        const cz = (box.minZ + box.maxZ) / 2;
                        if (Math.abs(nx - cx) / Math.max(box.maxX - box.minX, 0.01) > Math.abs(nz - cz) / Math.max(box.maxZ - box.minZ, 0.01)) {
                            nx = nx < cx ? box.minX - RADIUS : box.maxX + RADIUS;
                        } else {
                            nz = nz < cz ? box.minZ - RADIUS : box.maxZ + RADIUS;
                        }
                    }
                });
                return { x: nx, z: nz };
            }

            function eyeHeight() {
                return player.sitting ? SIT_EYE : EYE;
            }

            function setCameraFromPlayer() {
                // Lateral bob rides the camera's right vector so it reads as the body
                // swaying under the head rather than the world sliding sideways.
                const rx = Math.cos(player.yaw);
                const rz = -Math.sin(player.yaw);
                room.camera.position.set(
                    player.x + rx * view.bobX,
                    player.y + eyeHeight() + view.bobY - view.dip,
                    player.z + rz * view.bobX
                );
                applyYawPitch();
                if (view.roll) room.camera.rotateZ(view.roll);
            }

            function applyYawPitch() {
                room.camera.rotation.set(0, 0, 0);
                room.camera.rotateY(player.yaw);
                room.camera.rotateX(player.pitch);
            }

            function lerpAngle(a, b, t) {
                let d = b - a;
                while (d > Math.PI) d -= Math.PI * 2;
                while (d < -Math.PI) d += Math.PI * 2;
                return a + d * t;
            }

            function sitCameraPos() {
                return new THREE.Vector3(room.screen.x, SIT_EYE, room.screen.z + 0.82);
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

            function introStandPos() {
                return new THREE.Vector3(room.screen.x, EYE, room.chairZ + 0.62);
            }

            function lookAtScreenFrom(pos) {
                const target = new THREE.Vector3(room.screen.x, room.screen.y, room.screen.z);
                room.camera.position.copy(pos);
                room.camera.lookAt(target);
                player.yaw = Math.atan2(-(target.x - pos.x), -(target.z - pos.z));
                const dx = target.x - pos.x;
                const dy = target.y - pos.y;
                const dz = target.z - pos.z;
                player.pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
            }

            function frustumAt(distance) {
                const vFov = (room.camera.fov * Math.PI) / 180;
                const h = 2 * distance * Math.tan(vFov / 2);
                return { w: h * room.camera.aspect, h: h };
            }

            function fillDistance() {
                const vFov = (room.camera.fov * Math.PI) / 180;
                const halfTan = Math.tan(vFov / 2);
                const distH = room.screen.h / 2 / halfTan;
                const distW = room.screen.w / 2 / (halfTan * room.camera.aspect);
                return Math.min(distH, distW) * 0.995;
            }

            function layoutMonitorHtml(worldW, worldH) {
                const aspect = worldW / Math.max(worldH, 0.0001);
                // The page lays out at the viewport width, so the monitor shows the site at
                // exactly the resolution the 2D version would use. Pinning it to a fixed
                // narrower width made text larger, but it also meant going fullscreen grew
                // the panel without growing the layout -- so everything jumped in size.
                const vw = Math.max(Math.round(layer.clientWidth || 1280), 960);
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

            const cssPos = new THREE.Vector3();
            const cssQuat = new THREE.Quaternion();
            const cssScale = new THREE.Vector3();
            const animPos = new THREE.Vector3();
            let needsRender = true;
            let screenFacing = true;
            let lastHint = "";

            function markRender() {
                needsRender = true;
            }

            function syncMonitorPage() {
                if (!room || !room.cssObject || !room.htmlW) return;
                room.screenGlass.updateMatrixWorld(true);
                room.screenGlass.matrixWorld.decompose(cssPos, cssQuat, cssScale);
                room.cssObject.position.copy(cssPos);
                room.cssObject.quaternion.copy(cssQuat);
                // Track the mesh's own scale rather than the nominal screen width, so
                // anything that resizes the screen mesh carries the projected page with it.
                const s = cssScale.x / room.htmlW;
                room.cssObject.scale.set(s, s, s);
            }

            // The page on the monitor is the real .app element, projected by CSS3DRenderer.
            // Browsers hit-test 3D-transformed DOM correctly, so the only thing standing
            // between the viewer and a live page is pointer-events on the CSS3D container.
            // Enable it whenever the pointer is free; disable it during mouse-look so the
            // room takes the clicks instead.
            function setScreenInteractive(on) {
                if (!room || !room.cssRenderer) return;
                room.cssRenderer.domElement.style.pointerEvents = on ? "auto" : "none";
            }

            // "dom"    -- the live page projected by CSS3D: real clicks, hover, scrolling,
            //             but it is a DOM overlay, so the room cannot occlude it.
            // "canvas" -- the page captured into a texture on the screen mesh: properly
            //             depth-tested inside the scene, but input cannot reach a texture,
            //             so this pose is look-only. Uses html-in-canvas when the flag is
            //             on, otherwise a one-shot SVG bake so phones do not fall back to
            //             CSS3D (which drifts off the bezel at an angle).
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
                    // layout the CSS3D path was just showing.
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
                    material.color.setHex(0x0a0a0a);
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
                setScreenMode(inLookMode() ? "canvas" : "dom");
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
                if (room.cssRenderer) {
                    room.cssRenderer.render(room.cssScene, room.camera);
                }
            }

            function finishIntro() {
                if (player.playing) return;
                player.animating = false;
                player.playing = true;
                player.sitting = false;
                if (anim && anim.to) {
                    player.x = anim.to.x;
                    player.z = anim.to.z;
                    player.y = 0;
                    lookAtScreenFrom(anim.to);
                }
                player.vx = player.vy = player.vz = 0;
                room.camera.fov = FOV_STAND;
                room.camera.updateProjectionMatrix();
                layoutMonitorHtml(room.screen.w, room.screen.h);
                document.body.classList.add("room-playing");
                syncScreenInteractive();
                markRender();
                refreshHint();
            }

            function setFov(fov) {
                room.camera.fov = fov;
                room.camera.updateProjectionMatrix();
            }

            function beginPoseAnim(kind, to, toFov, duration) {
                if (document.pointerLockElement) document.exitPointerLock();
                player.animating = true;
                setScreenInteractive(false);
                markRender();
                player.vx = player.vy = player.vz = 0;
                const target = new THREE.Vector3(room.screen.x, room.screen.y, room.screen.z);
                const dx = target.x - to.x;
                const dy = target.y - to.y;
                const dz = target.z - to.z;
                anim = {
                    kind: kind,
                    from: room.camera.position.clone(),
                    to: to,
                    fromYaw: player.yaw,
                    toYaw: Math.atan2(-dx, -dz),
                    fromPitch: player.pitch,
                    toPitch: Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)),
                    fromFov: room.camera.fov,
                    toFov: toFov,
                    start: performance.now(),
                    duration: duration
                };
            }

            function sitDown() {
                if (!player.playing || player.animating || player.sitting) return;
                player.standX = player.x;
                player.standZ = player.z;
                beginPoseAnim("sit", sitCameraPos(), FOV_SIT, 3200);
                clearPrompt();
            }

            function standUp() {
                if (!player.playing || player.animating || !player.sitting) return;
                player.sitting = false;
                const to = new THREE.Vector3(
                    player.standX != null ? player.standX : player.x,
                    EYE,
                    player.standZ != null ? player.standZ : player.z
                );
                beginPoseAnim("stand", to, FOV_STAND, 2600);
                clearPrompt();
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

                let next = "";
                if (player.sitting) {
                    next = touch.enabled
                        ? "Tap the screen \u00b7 <b>STAND</b> to get up"
                        : "<b>E</b> leave the desk";
                } else if (!inLookMode()) {
                    // Checked before the desk hint: in screen mode the USE button is hidden,
                    // so prompting for it would point at a control that is not on screen.
                    next = touch.enabled ? "" : "Click the room to look around";
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
            let anim = null;
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
            const VOID_PULL = 7600;                  // deliberately unhurried
            const VOID_MASS = 0.013;                 // lensing strength at full collapse
            const VOID_PARTICLES = 13;               // particleCount
            const VOID_ZOOM = 1.8;                   // zoom
            const VOID_ORB = 0.75;                   // orbSize
            const VOID_GLOW = 0.08;                  // glow
            const VOID_CONTRAST = 3.0;               // contrast
            const VOID_COLOR_SPEED = 0.2;            // colorSpeed
            const VOID_COLOR_SHIFT = [-6, -6, -6];   // colorShiftR/G/B
            const VOID_FADE = 0.35;                  // distanceFade
            const VOID_SPLITS = 2.0;                 // mirrorSplits
            const VOID_SPEED = 0.075;                // speed -- far below the component's 1.0

            const LENS_VERT = [
                "varying vec2 vUv;",
                "void main() {",
                "    vUv = uv;",
                "    gl_Position = vec4(position.xy, 0.0, 1.0);",
                "}"
            ].join("\n");

            const LENS_FRAG = [
                "precision highp float;",
                "#define PI 3.14159265359",
                "#define PARTICLES " + VOID_PARTICLES,
                "uniform sampler2D u_image;",
                "uniform vec2 u_center;",
                "uniform float u_aspect;",
                "uniform float u_mass;",
                "uniform float u_swirl;",
                "uniform float u_time;",
                "uniform float u_progress;",
                "uniform float u_zoom;",
                "uniform float u_orbSize;",
                "uniform float u_glow;",
                "uniform float u_contrast;",
                "uniform float u_colorSpeed;",
                "uniform vec3 u_colorShift;",
                "uniform float u_distanceFade;",
                "uniform float u_mirrorSplits;",
                "uniform float u_settle;",
                "uniform float u_saturation;",
                "uniform vec3 u_accent;",
                "varying vec2 vUv;",
                "",
                // Kaleidoscope warp: fold the plane into mirrored wedges around the core.
                "vec2 kaleido(vec2 p, float splits) {",
                "    float r = length(p);",
                "    float a = atan(p.y, p.x);",
                "    float seg = PI / max(splits, 1.0);",
                "    a = abs(mod(a + seg, seg * 2.0) - seg);",
                "    return vec2(cos(a), sin(a)) * r;",
                "}",
                "",
                "void main() {",
                // -- the room, bent toward the singularity ---------------------------
                "    vec2 toCenter = vUv - u_center;",
                "    float dist = length(toCenter * vec2(u_aspect, 1.0));",
                "    float pull = u_mass / max(dist * dist, 1e-6);",
                "    vec2 sampleUv = u_center + toCenter * cos((pull + u_swirl) * PI);",
                "    vec3 room = texture2D(u_image, sampleUv).rgb - pull * 0.25;",
                "    room = max(room, vec3(0.0)) * (1.0 - u_progress);",
                "",
                // -- the black hole itself -------------------------------------------
                "    vec2 p = toCenter * vec2(u_aspect, 1.0) / u_zoom;",
                "    vec2 warped = kaleido(p, u_mirrorSplits);",
                "    vec3 acc = vec3(0.0);",
                "    for (int i = 0; i < PARTICLES; i++) {",
                "        float fi = float(i);",
                "        float radius = u_orbSize * (0.055 + 0.021 * fi) *",
                "            (0.86 + 0.14 * sin(u_time * 0.45 + fi * 1.7));",
                "        float ang = u_time * (0.95 - 0.042 * fi) + fi * (PI * 2.0 / float(PARTICLES));",
                "        vec2 orbit = vec2(cos(ang), sin(ang)) * radius;",
                "        float d = max(length(warped - orbit), 0.0025);",
                "        vec3 tint = 0.5 + 0.5 * cos(",
                "            vec3(u_time * u_colorSpeed + fi * 0.5) + u_colorShift +",
                "            vec3(0.0, 2.0944, 4.1888));",
                // A full-strength rainbow spends a third of its cycle in magenta, which is
                // where the pink cast came from. Pull most of the saturation out and bias
                // what is left toward the theme accent, so the glow stays the site's colour
                // instead of drifting through pink.
                "        float tl = dot(tint, vec3(0.2126, 0.7152, 0.0722));",
                "        tint = mix(vec3(tl), tint, u_saturation);",
                "        tint = mix(tint, u_accent, 0.30);",
                "        acc += tint * (u_glow / d);",
                "    }",
                "    acc *= exp(-length(warped) / max(u_distanceFade, 0.01));",
                // Event horizon: the core stays absolutely black.
                "    float horizon = smoothstep(u_orbSize * 0.052, u_orbSize * 0.040, length(warped));",
                "    acc *= 1.0 - horizon;",
                // glow/distance is unbounded, so it has to be tone-mapped into range before
                // the contrast exponent -- raising raw values of 20+ to the power of 3 is
                // what turns the whole thing into a white blob.
                "    acc = acc / (1.0 + acc);",
                "    acc = pow(max(acc, vec3(0.0)), vec3(u_contrast));",
                // Once the collapse is over the colour cycle would leave a magenta cast
                // sitting under the death screen, so it settles to neutral and dims.
                "    float lum = dot(acc, vec3(0.2126, 0.7152, 0.0722));",
                "    acc = mix(acc, vec3(lum), u_settle);",
                "    acc *= 1.0 - 0.62 * u_settle;",
                "",
                "    vec3 color = room + acc * u_progress;",
                "    color *= 1.0 - horizon * u_progress;",
                "    gl_FragColor = vec4(color, 1.0);",
                "}"
            ].join("\n");

            function startBlackHole() {
                if (blackHole || !room || !player.playing) return;
                if (document.pointerLockElement) document.exitPointerLock();
                setScreenInteractive(false);
                releaseKeys();
                anim = null;
                player.animating = false;
                player.vx = player.vy = player.vz = 0;

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

                const material = new THREE.ShaderMaterial({
                    uniforms: {
                        u_image: { value: target.texture },
                        u_center: { value: new THREE.Vector2(0.5, 0.5) },
                        u_aspect: { value: Math.max(size.x, 1) / Math.max(size.y, 1) },
                        u_mass: { value: 0 },
                        u_swirl: { value: 0 },
                        u_time: { value: 0 },
                        u_progress: { value: 0 },
                        u_zoom: { value: VOID_ZOOM },
                        u_orbSize: { value: VOID_ORB },
                        u_glow: { value: VOID_GLOW },
                        u_contrast: { value: VOID_CONTRAST },
                        u_colorSpeed: { value: VOID_COLOR_SPEED },
                        u_colorShift: { value: new THREE.Vector3().fromArray(VOID_COLOR_SHIFT) },
                        u_distanceFade: { value: VOID_FADE },
                        u_mirrorSplits: { value: VOID_SPLITS },
                        u_settle: { value: 0 },
                        u_saturation: { value: 0.22 },
                        u_accent: { value: roomPalette().accent.clone() }
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
                    done: false,
                    doneAt: 0,
                    accent: roomPalette().accent.clone(),
                    pivot: pivot,
                    homes: homes,
                    pivotHome: pivot.position.clone()
                };
                clearPrompt();
                markRender();
            }

            function stepBlackHole(now) {
                const k = easeInOut(Math.min(1, (now - blackHole.start) / VOID_PULL));
                const pivot = blackHole.pivot;

                // Screen, bezel, neck and foot all ride the same pivot, so the monitor goes
                // in as one object with the page still on it.
                const shrink = Math.max(1 - k, 0.0001);
                pivot.scale.setScalar(shrink);
                const spin = k * Math.PI * 3;
                const radius = 0.17 * Math.sin(k * Math.PI);
                pivot.position.set(
                    blackHole.pivotHome.x + Math.cos(spin) * radius,
                    blackHole.pivotHome.y + Math.sin(spin) * radius * 0.6,
                    blackHole.pivotHome.z
                );
                pivot.rotation.z = spin * 0.6;

                // Anchor the singularity to where the screen actually is on the viewport.
                lensCenter.set(blackHole.pivotHome.x, blackHole.pivotHome.y, blackHole.pivotHome.z);
                lensCenter.project(room.camera);
                const uniforms = blackHole.material.uniforms;
                uniforms.u_center.value.set(lensCenter.x * 0.5 + 0.5, lensCenter.y * 0.5 + 0.5);
                // Everything the collapse touches runs off the same k, at the same rate:
                // the monitor shrinking, the room bending, the particles rising. The room
                // used to start bending late and ramp quadratically -- that existed only to
                // hide a crisp DOM overlay over an already-warped room, and the page is part
                // of the scene now, so all it did was make the monitor look detached from
                // the room it was being pulled into.
                uniforms.u_mass.value = VOID_MASS * k;
                uniforms.u_swirl.value = k * 1.15;
                uniforms.u_time.value = (now - blackHole.start) * 0.001 * VOID_SPEED;
                uniforms.u_progress.value = k;

                uniforms.u_settle.value = blackHole.doneAt
                    ? Math.min(1, (now - blackHole.doneAt) / 2600)
                    : 0;

                if (k >= 1 && !blackHole.done) {
                    blackHole.done = true;
                    blackHole.doneAt = now;
                    blackHole.pivot.visible = false;
                    overlay.style.visibility = "hidden";
                    document.body.classList.add("room-void");
                }
                markRender();
            }

            function clearBlackHole() {
                document.body.classList.remove("room-void");
                if (!blackHole) return;
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

            function easeInOut(t) {
                return t * t * t * (t * (t * 6 - 15) + 10);
            }

            function easePull(t) {
                return easeInOut(easeInOut(t));
            }

            function tick(now) {
                raf = requestAnimationFrame(tick);
                const frameMs = now - last;
                const dt = Math.min(0.05, frameMs / 1000 || 0.016);
                last = now;
                // Holding pointer lock is not motion: the camera only changes when the mouse
                // actually moves, and onMouseMove already asks for a frame. Treating "locked"
                // as "dirty" meant standing still in mouse-look redrew the room forever.
                if (player.animating || touch.stick.active || touch.jump ||
                    keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || keys.Space ||
                    Math.hypot(player.vx, player.vz) > 0.004 || !player.onGround) {
                    needsRender = true;
                }

                if (blackHole) {
                    stepBlackHole(now);
                } else if (player.animating && anim) {
                    const t = Math.min(1, (now - anim.start) / anim.duration);
                    const k = anim.kind === "intro" ? easePull(t) : easeInOut(t);
                    const pos = animPos.copy(anim.from).lerp(anim.to, k);
                    player.x = pos.x;
                    player.y = 0;
                    player.z = pos.z;
                    if (anim.kind === "intro") {
                        lookAtScreenFrom(pos);
                        if (anim.fromFov != null) {
                            setFov(anim.fromFov + (anim.toFov - anim.fromFov) * k);
                        }
                        if (t >= 1) finishIntro();
                    } else {
                        room.camera.position.copy(pos);
                        player.yaw = lerpAngle(anim.fromYaw, anim.toYaw, k);
                        player.pitch = anim.fromPitch + (anim.toPitch - anim.fromPitch) * k;
                        setFov(anim.fromFov + (anim.toFov - anim.fromFov) * k);
                        applyYawPitch();
                        if (t >= 1) {
                            player.animating = false;
                            player.x = anim.to.x;
                            player.z = anim.to.z;
                            if (anim.kind === "sit") player.sitting = true;
                            if (anim.kind === "stand") player.sitting = false;
                            setFov(anim.toFov);
                            syncScreenInteractive();
                            refreshHint();
                        }
                    }
                } else if (player.playing && !player.sitting) {
                    // strafe: +right, back: +backward. Keyboard is digital; the mobile
                    // stick is analog and its magnitude scales wishspeed, so a half-pushed
                    // thumb walks rather than runs.
                    let strafe = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
                    let back = (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0);
                    if (touch.stick.active) {
                        strafe = touch.stick.x;
                        back = -touch.stick.y;
                    }
                    const inputLen = Math.min(1, Math.hypot(strafe, back));

                    const sin = Math.sin(player.yaw);
                    const cos = Math.cos(player.yaw);
                    let wishX = strafe * cos + back * sin;
                    let wishZ = -strafe * sin + back * cos;
                    const wishLen = Math.hypot(wishX, wishZ);
                    if (wishLen > 0) {
                        wishX /= wishLen;
                        wishZ /= wishLen;
                    }
                    const sprinting = keys.ShiftLeft || keys.ShiftRight || touch.stick.sprint;
                    const wishSpeed = wishLen > 0
                        ? (sprinting ? SPEED_SPRINT : SPEED_WALK) * inputLen
                        : 0;

                    // Source splits gravity around the move so the jump arc integrates
                    // correctly at any framerate.
                    player.vy -= SV_GRAVITY * dt * 0.5;

                    const jumpHeld = keys.Space || touch.jump;
                    if (!jumpHeld) player.jumpLatched = false;

                    if (player.onGround) {
                        if (jumpHeld && !player.jumpLatched) {
                            player.vy = JUMP_IMPULSE;
                            player.onGround = false;
                            player.jumpLatched = true;
                        } else {
                            applyFriction(dt);
                            accelerate(wishX, wishZ, wishSpeed, SV_ACCELERATE, dt);
                        }
                    } else {
                        airAccelerate(wishX, wishZ, wishSpeed, dt);
                    }

                    const nx = player.x + player.vx * dt;
                    const nz = player.z + player.vz * dt;
                    const hit = collide(nx, nz, player.y);
                    if (hit.x !== nx) player.vx = 0;
                    if (hit.z !== nz) player.vz = 0;
                    player.x = hit.x;
                    player.z = hit.z;

                    player.y += player.vy * dt;
                    player.vy -= SV_GRAVITY * dt * 0.5;
                    const support = supportHeight(player.x, player.z);
                    if (player.y <= support) {
                        if (!player.onGround) {
                            view.impact = Math.min(1, Math.abs(player.vy) / (JUMP_IMPULSE * 1.3));
                        }
                        player.y = support;
                        player.vy = 0;
                        player.onGround = true;
                    } else if (player.vy <= 0) {
                        // Walked off an edge: start falling instead of striding on air.
                        player.onGround = false;
                    }

                    updateViewBob(dt);
                    setCameraFromPlayer();
                } else if (player.playing && player.sitting) {
                    updateViewBob(dt);
                    setCameraFromPlayer();
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
                setFov(FOV_FILL);
                layoutMonitorHtml(room.screen.w, room.screen.h);
                const d0 = Math.max(fillDistance(), 0.12);
                const start = new THREE.Vector3(room.screen.x, room.screen.y, room.screen.z + d0);
                const end = introStandPos();
                lookAtScreenFrom(start);
                player.x = start.x;
                player.y = 0;
                player.z = start.z;
                player.vx = player.vy = player.vz = 0;
                player.playing = false;
                player.animating = false;
                player.sitting = false;
                document.body.classList.remove("room-playing");
                markRender();
                if (reduceMotion) {
                    setFov(FOV_STAND);
                    lookAtScreenFrom(end);
                    player.x = end.x;
                    player.z = end.z;
                    finishIntro();
                    if (!raf) raf = requestAnimationFrame(tick);
                    renderRoom();
                    return;
                }
                player.animating = true;
                anim = {
                    kind: "intro",
                    from: start,
                    to: end,
                    fromFov: FOV_FILL,
                    toFov: FOV_STAND,
                    start: performance.now(),
                    duration: 5500
                };
                clearPrompt();
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
                requestLook();
            }

            function onMouseMove(event) {
                if (!player.locked || !player.playing || player.animating) return;
                player.yaw -= event.movementX * LOOK_SCALE;
                player.pitch -= event.movementY * LOOK_SCALE;
                const lim = player.sitting ? Math.PI / 5 : PITCH_LIMIT;
                player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
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
                document.body.classList.remove("room-active", "room-playing", "room-touch", "room-look");
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
                if (touch.enabled) {
                    resetTouch();
                } else {
                    requestLook();
                }
                try {
                    await ensureRoomLibs();
                    if (!room) room = createRoom();
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
            const STICK_SPRINT = 0.92;

            function resetTouch() {
                touch.stick.active = false;
                touch.stick.sprint = false;
                touch.stick.x = 0;
                touch.stick.y = 0;
                touch.stick.id = -1;
                touch.look.id = -1;
                touch.jump = false;
                if (stickEl) stickEl.classList.remove("active", "sprint");
                if (nubEl) nubEl.style.transform = "";
                if (jumpBtn) jumpBtn.classList.remove("held");
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
                    touch.stick.sprint = false;
                } else {
                    // Rescale past the dead zone so the first millimetre of travel is not a
                    // jump straight to walking speed.
                    const scaled = (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE) / mag;
                    touch.stick.x = nx * scaled;
                    touch.stick.y = ny * scaled;
                    touch.stick.sprint = mag > STICK_SPRINT;
                }
                if (stickEl) stickEl.classList.toggle("sprint", touch.stick.sprint);
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
                    if (!player.animating) {
                        player.yaw -= (event.clientX - touch.look.lastX) * TOUCH_LOOK_SCALE;
                        player.pitch -= (event.clientY - touch.look.lastY) * TOUCH_LOOK_SCALE;
                        const lim = player.sitting ? Math.PI / 5 : PITCH_LIMIT;
                        player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
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
                    touch.stick.sprint = false;
                    touch.stick.x = 0;
                    touch.stick.y = 0;
                    if (stickEl) stickEl.classList.remove("active", "sprint");
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

            function bindHold(el, onDown, onUp) {
                if (!el) return;
                el.addEventListener("pointerdown", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    el.classList.add("held");
                    onDown();
                });
                const release = (event) => {
                    if (event) event.stopPropagation();
                    el.classList.remove("held");
                    if (onUp) onUp();
                };
                el.addEventListener("pointerup", release);
                el.addEventListener("pointercancel", release);
                el.addEventListener("pointerleave", release);
            }

            bindHold(jumpBtn, () => { touch.jump = true; markRender(); }, () => { touch.jump = false; });

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
                if (event.code === "Escape") {
                    if (player.locked) return;
                    event.preventDefault();
                    exitRoom();
                }
                if (event.code === "KeyE" && player.playing && !player.animating) {
                    event.preventDefault();
                    if (player.sitting) standUp();
                    else if (lookingAtChair()) sitDown();
                }
                if (player.sitting && ["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
                    event.preventDefault();
                    standUp();
                }
                if (player.locked && ["KeyW", "KeyA", "KeyS", "KeyD", "Space"].includes(event.code)) {
                    event.preventDefault();
                }
            });
            document.addEventListener("keyup", (event) => {
                keys[event.code] = false;
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
                }
                if (!player.animating) layoutMonitorHtml(room.screen.w, room.screen.h);
                markRender();
            });
        })();
