        (function () {
            // One compact label at every width -- the long "Modus Operandi" form and its
            // subtitle are gone, so the control reads the same on desktop as on a phone.
            const THEMES = {
                "modus-vivendi": {
                    label: "OPERANDI",
                    next: "modus-operandi",
                    metaColor: "#000000",
                    ariaLabel: "Switch to Modus Operandi light theme"
                },
                "modus-operandi": {
                    label: "VIVENDI",
                    next: "modus-vivendi",
                    metaColor: "#ffffff",
                    ariaLabel: "Switch to Modus Vivendi dark theme"
                }
            };

            function getTheme() {
                return document.documentElement.dataset.theme === "modus-operandi"
                    ? "modus-operandi"
                    : "modus-vivendi";
            }

            function applyTheme(theme, persist) {
                document.documentElement.dataset.theme = theme;
                const config = THEMES[theme];
                const meta = document.querySelector('meta[name="theme-color"]');
                if (meta) meta.setAttribute("content", config.metaColor);

                document.querySelectorAll(".theme-toggle").forEach((button) => {
                    button.setAttribute("aria-label", config.ariaLabel);
                    const label = button.querySelector(".theme-label");
                    if (label) label.textContent = config.label;
                });

                if (typeof window.updateHeaderCubeTheme === "function") {
                    window.updateHeaderCubeTheme();
                }
                if (typeof window.updateRoomTheme === "function") {
                    window.updateRoomTheme();
                }

                if (persist) {
                    localStorage.setItem("resume-theme", theme);
                }
            }

            applyTheme(getTheme(), false);

            document.querySelectorAll(".theme-toggle").forEach((button) => {
                button.addEventListener("click", () => {
                    const next = THEMES[getTheme()].next;
                    applyTheme(next, true);
                });
            });

            // The label no longer depends on viewport width, so nothing here needs to run
            // on resize -- this used to re-tint every room material on every resize event.
        })();
        (function () {
            const headerCanvases = [
                document.getElementById("header-cube-mobile"),
                document.getElementById("header-cube-desktop"),
            ].filter(Boolean);
            const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            const cubeMaterials = [];

            // The cube is line art, like the room's and the game's: faces in the background
            // colour so the depth buffer hides the far edges, the edges in the accent.
            function readCubeColors() {
                const style = getComputedStyle(document.documentElement);
                return {
                    bg: style.getPropertyValue("--bg").trim(),
                    color: style.getPropertyValue("--cube-color").trim()
                };
            }

            function cubeCssSize() {
                const rootStyle = getComputedStyle(document.documentElement);
                return parseInt(rootStyle.getPropertyValue("--cube-size"), 10) || 32;
            }

            function syncRendererSize(viewer) {
                const px = cubeCssSize(viewer.canvas);
                const dpr = Math.min(window.devicePixelRatio || 1, 2);
                viewer.renderer.setPixelRatio(dpr);
                viewer.renderer.setSize(px, px, false);
            }

            function makeCube() {
                const colors = readCubeColors();
                const geometry = new THREE.BoxGeometry(0.72, 0.72, 0.72);
                const material = new THREE.MeshBasicMaterial({
                    color: colors.bg,
                    polygonOffset: true,
                    polygonOffsetFactor: 1,
                    polygonOffsetUnits: 1
                });
                const cube = new THREE.Mesh(geometry, material);
                const wireMaterial = new THREE.LineBasicMaterial({ color: colors.color });
                cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), wireMaterial));
                cubeMaterials.push({ material, wireMaterial });
                return cube;
            }

            function initHeaderViewer(canvas) {
                if (reduceMotion || typeof THREE === "undefined" || !canvas) return null;
                try {
                    const scene = new THREE.Scene();
                    const cam = 1.05;
                    const camera = new THREE.OrthographicCamera(-cam, cam, cam, -cam, 0.1, 100);
                    camera.position.z = 5;
                    const renderer = new THREE.WebGLRenderer({
                        canvas: canvas,
                        alpha: true,
                        antialias: true,
                        powerPreference: "low-power"
                    });
                    renderer.setClearColor(0x000000, 0);
                    const cube = makeCube();
                    cube.position.set(0, 0, 0);
                    scene.add(cube);
                    const viewer = {
                        canvas,
                        scene,
                        camera,
                        renderer,
                        cube,
                        resize() {
                            syncRendererSize(viewer);
                        }
                    };
                    syncRendererSize(viewer);
                    return viewer;
                } catch (error) {
                    console.error("Header cube init failed:", error);
                    canvas.style.display = "none";
                    return null;
                }
            }

            const headerViewers = headerCanvases
                .map((canvas) => initHeaderViewer(canvas))
                .filter(Boolean);

            window.updateHeaderCubeTheme = function () {
                const colors = readCubeColors();
                cubeMaterials.forEach((entry) => {
                    entry.material.color.set(colors.bg);
                    entry.wireMaterial.color.set(colors.color);
                });
            };

            // This used to bail out while the room was open, on the assumption the cube was
            // off-screen. It isn't -- the page it lives in is on the monitor, so bailing
            // froze the cube on its last frame and a theme switch recoloured the material
            // with nothing left to redraw it. Two 32px canvases cost nothing; keep drawing.
            // Two 32px WebGL contexts do not cost much on their own, but a getComputedStyle
            // per canvas per frame forces a style recalc 120 times a second for the life of
            // the page. offsetParent answers the same question without one, and 24fps is
            // plenty for a slow tumble.
            const CUBE_INTERVAL = 1000 / 24;
            let cubeLast = 0;

            function animate(now) {
                requestAnimationFrame(animate);
                if (now - cubeLast < CUBE_INTERVAL) return;
                const step = Math.min((now - cubeLast) / 16.67, 4);
                cubeLast = now;
                // In the room the page is a baked snapshot, so a spinning cube is not
                // visible and not worth drawing.
                if (document.body.classList.contains("room-look")) return;
                headerViewers.forEach((viewer) => {
                    if (viewer.canvas.offsetParent === null) return;
                    if (viewer.cube) {
                        viewer.cube.rotation.x += 0.003 * step;
                        viewer.cube.rotation.y += 0.004 * step;
                    }
                    viewer.renderer.render(viewer.scene, viewer.camera);
                });
            }

            function onWindowResize() {
                headerViewers.forEach((viewer) => viewer.resize());
            }

            if (headerViewers.length) {
                requestAnimationFrame(animate);
                window.addEventListener("resize", onWindowResize);
                if ("ResizeObserver" in window) {
                    const observer = new ResizeObserver(() => onWindowResize());
                    headerCanvases.forEach((canvas) => observer.observe(canvas));
                }
            } else {
                headerCanvases.forEach((canvas) => {
                    canvas.style.display = "none";
                });
            }

            const termPath = document.getElementById("term-path");
            const mobilePath = document.getElementById("mobile-path");
            const menuItems = document.querySelectorAll(".menu-item");
            const sections = document.querySelectorAll(".content-section");

            function switchContent(targetId) {
                const target = document.getElementById(targetId);
                if (!target) return;
                sections.forEach((section) => {
                    section.classList.toggle("active", section.id === targetId);
                });
                menuItems.forEach((item) => {
                    item.classList.toggle("active", item.getAttribute("data-target") === targetId);
                });
                const prompt = "pi@resume:~/$ " + targetId;
                if (termPath) termPath.textContent = prompt;
                if (mobilePath) mobilePath.textContent = prompt;
                const termBody = document.querySelector(".term-body");
                if (termBody) termBody.scrollTop = 0;
            }

            menuItems.forEach((item) => {
                item.addEventListener("click", () => switchContent(item.getAttribute("data-target")));
            });
        })();

        (function () {
            // Draggable terminal window: grab the title bar to move it, double
            // click to snap back. Touch keeps native scrolling.
            const terminal = document.querySelector(".terminal");
            const bar = document.querySelector(".term-bar");
            let ox = 0, oy = 0;

            function apply() {
                if (!terminal) return;
                terminal.style.transform = (ox || oy) ? "translate(" + ox + "px," + oy + "px)" : "";
            }

            function reset() { ox = 0; oy = 0; apply(); }

            // The frame collides with the layout instead of leaving it: on
            // desktop it stays right of the sidebar and above the footer,
            // everywhere else inside the viewport.
            function clamp(nx, ny) {
                const r = terminal.getBoundingClientRect();
                const bx = r.left - ox, by = r.top - oy;
                let minX = 80 - (bx + r.width), maxX = window.innerWidth - 80 - bx;
                let minY = -by, maxY = window.innerHeight - 60 - by;
                if (window.matchMedia("(min-width: 861px)").matches) {
                    const side = document.querySelector(".sidebar").getBoundingClientRect();
                    minX = side.right - bx;
                    maxX = window.innerWidth - bx - r.width;
                    // The floor is the buttons themselves, not the row: empty
                    // middle lets the frame slide past them.
                    let wall = window.innerHeight;
                    document.querySelectorAll(".social-links .social-link, .social-links .theme-toggle").forEach((el) => {
                        const b = el.getBoundingClientRect();
                        if (b.width === 0) return;
                        if (bx + nx + r.width > b.left && bx + nx < b.right) {
                            wall = Math.min(wall, b.top);
                        }
                    });
                    maxY = wall - by - r.height;
                }
                nx = Math.min(Math.max(nx, minX), Math.max(maxX, minX));
                ny = Math.min(Math.max(ny, minY), Math.max(maxY, minY));
                return [nx, ny];
            }

            if (terminal && bar) {
                bar.addEventListener("pointerdown", (start) => {
                    // Touch keeps native scrolling; mouse and pen can drag.
                    if (start.pointerType === "touch") return;
                    if (start.button !== 0 || document.body.classList.contains("term-zoom")) return;
                    start.preventDefault();
                    const sx = start.clientX - ox, sy = start.clientY - oy;
                    function move(ev) {
                        const c = clamp(ev.clientX - sx, ev.clientY - sy);
                        ox = c[0]; oy = c[1]; apply();
                    }
                    function stop() {
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", stop);
                        window.removeEventListener("pointercancel", stop);
                    }
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", stop);
                    window.addEventListener("pointercancel", stop);
                });
                bar.addEventListener("dblclick", reset);
                // A resize can strand the frame outside its walls; pull it back.
                window.addEventListener("resize", () => {
                    const c = clamp(ox, oy);
                    ox = c[0]; oy = c[1]; apply();
                });
            }

            // The room bakes this page onto its monitor, so entering it snaps
            // the frame back and leaves zoom: neither would bake correctly.
            // Registered before room.js, so this runs first on the same click.
            const roomEnter = document.getElementById("room-enter");
            if (roomEnter) roomEnter.addEventListener("click", () => {
                reset();
                document.body.classList.remove("term-zoom");
            });

            // The spinning cube zooms the frame to the browser window. Esc
            // leaves. Touch devices are excluded: the cube is the only way
            // out and zoom would cover it.
            document.querySelectorAll(".header-cube").forEach((cube) => {
                cube.title = "Zoom terminal";
                cube.addEventListener("click", () => {
                    if (window.matchMedia("(pointer: coarse)").matches) return;
                    if (!document.body.classList.contains("term-zoom")) reset();
                    document.body.classList.toggle("term-zoom");
                });
            });
            window.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && document.body.classList.contains("term-zoom") &&
                    !document.body.classList.contains("room-active")) {
                    document.body.classList.remove("term-zoom");
                }
            });
        })();
