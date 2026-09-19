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

            function readCubeColors() {
                const style = getComputedStyle(document.documentElement);
                function hex(name) {
                    return parseInt(style.getPropertyValue(name).trim().replace("#", ""), 16);
                }
                return {
                    color: hex("--cube-color"),
                    emissive: hex("--cube-emissive"),
                    specular: hex("--cube-specular")
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
                const material = new THREE.MeshPhongMaterial({
                    color: colors.color,
                    emissive: colors.emissive,
                    shininess: 90,
                    specular: colors.specular,
                    transparent: true,
                    opacity: 0.92
                });
                const cube = new THREE.Mesh(geometry, material);
                const edges = new THREE.EdgesGeometry(geometry);
                const wireMaterial = new THREE.LineBasicMaterial({
                    color: colors.color,
                    transparent: true,
                    opacity: 0.85
                });
                const wire = new THREE.LineSegments(edges, wireMaterial);
                cube.add(wire);
                cubeMaterials.push({ material, wireMaterial, pointLight: null });
                return cube;
            }

            function addLights(scene) {
                scene.add(new THREE.AmbientLight(0xcccccc, 0.65));
                const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
                directionalLight.position.set(1, 2, 1).normalize();
                scene.add(directionalLight);
                const colors = readCubeColors();
                const pointLight = new THREE.PointLight(colors.color, 0.85, 100);
                pointLight.position.set(-2, -1, 2);
                scene.add(pointLight);
                const entry = cubeMaterials[cubeMaterials.length - 1];
                if (entry) entry.pointLight = pointLight;
            }

            function initHeaderViewer(canvas) {
                if (reduceMotion || typeof THREE === "undefined" || !canvas) return null;
                try {
                    const px = cubeCssSize();
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
                    addLights(scene);
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
                    entry.material.color.setHex(colors.color);
                    entry.material.emissive.setHex(colors.emissive);
                    entry.material.specular.setHex(colors.specular);
                    entry.wireMaterial.color.setHex(colors.color);
                    if (entry.pointLight) entry.pointLight.color.setHex(colors.color);
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