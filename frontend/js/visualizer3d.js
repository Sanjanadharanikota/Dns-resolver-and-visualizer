/* visualizer3d.js — final version with theme-aware color and animation improvements */
(function () {
  const DNSVisualizer3D = function () {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.nodes = {};
    this.curves = {};
    this.packet = null;
    this.running = false;
    this.speedMultiplier = 0.6;
    this.autoRotate = false;
    this._raf = null;
    this._lastTrace = null;
    this.currentTheme = document.documentElement.getAttribute("data-theme") || "light";
    this.container = null;
    this.labels = {};
    this.currentContext = "";
    this.followPacket = false;
    this._autoRotateSaved = false;
    this.timings = {};
    this.pathLines = [];
    this.lastPathCurveKeys = [];
    this.pathArrows = [];
    this.nxdomainSprite = null;
  };

  DNSVisualizer3D.prototype._showNXDomainBanner = function (text = 'This domain does not exist') {
    try {
      // Remove existing banner if any
      if (this.nxdomainSprite) {
        this.scene.remove(this.nxdomainSprite);
        this.nxdomainSprite = null;
      }
      const banner = this._createLabelSprite(text, 'danger');
      // Place roughly in front of the camera focus
      const { center } = this._computeNodesBounds();
      banner.position.set(center.x, center.y + 2.2, center.z);
      banner.visible = true;
      this.scene.add(banner);
      this.nxdomainSprite = banner;
    } catch (_) {}
  };

  DNSVisualizer3D.prototype._hideNXDomainBanner = function () {
    try {
      if (this.nxdomainSprite) {
        this.scene.remove(this.nxdomainSprite);
        if (this.nxdomainSprite.material && this.nxdomainSprite.material.dispose) this.nxdomainSprite.material.dispose();
        this.nxdomainSprite = null;
      }
    } catch (_) {}
  };

  DNSVisualizer3D.prototype._sphere = function (radius = 0.8, colorHex = 0x60a5fa) {
    const geo = new THREE.SphereGeometry(radius, 32, 24);
    const mat = new THREE.MeshPhongMaterial({
      color: colorHex,
      emissive: colorHex,
      emissiveIntensity: this.currentTheme === "dark" ? 0.6 : 0.35,
      shininess: 60,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { baseEmissive: colorHex };
    return mesh;
  };

  DNSVisualizer3D.prototype.init = function (containerId) {
    const container = document.getElementById(containerId);
    if (!container) throw new Error("Visualizer container not found");
    this.container = container;

    // Ensure info card has proper styling class
    const infoEl = document.getElementById("infoCard");
    if (infoEl && !infoEl.classList.contains("info-card")) infoEl.classList.add("info-card");

    const w = container.clientWidth, h = container.clientHeight;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    this.camera.position.set(0, 6, 16);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.innerHTML = "";
    container.appendChild(this.renderer.domElement);

    // Orbit controls for 360° view
    if (THREE.OrbitControls) {
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.rotateSpeed = 0.5;
      this.controls.zoomSpeed = 0.6;
      this.controls.panSpeed = 0.6;
      this.controls.minDistance = 6;
      this.controls.maxDistance = 50;
      this.controls.enablePan = true;
      this.controls.autoRotate = false;
    }

    this._setupLights();
    this._setupNodes();
    this._buildCurves();

    const pktGeo = new THREE.TetrahedronGeometry(0.35);
    // Darker packet color for better appearance
    const pktMat = new THREE.MeshPhongMaterial({ color: 0x1f2937, emissive: 0x111827, emissiveIntensity: 0.6 });
    this.packet = new THREE.Mesh(pktGeo, pktMat);
    this.packet.visible = false;
    this.scene.add(this.packet);

    this._observeTheme();
    this._applyTheme();

    const animate = () => {
      // Follow the packet only during resolving to show its path clearly
      if (this.followPacket && this.packet && this.packet.visible) {
        try {
          if (this.controls) this.controls.target.copy(this.packet.position);
          else this.camera.lookAt(this.packet.position);
        } catch (_) {}
      }
      // Use OrbitControls auto-rotate when idle
      if (this.controls) this.controls.autoRotate = !!(this.autoRotate && !this.running && !this.followPacket);
      if (this.controls) this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(animate);
    };
    animate();

    window.addEventListener("resize", () => this._onResize());
  };

  DNSVisualizer3D.prototype._setupLights = function () {
    const dark = this.currentTheme === "dark";
    const ambient = new THREE.AmbientLight(0xffffff, dark ? 0.6 : 1.0);
    const point = new THREE.PointLight(0xffffff, dark ? 0.9 : 0.7);
    point.position.set(6, 10, 8);
    this.scene.add(ambient);
    this.scene.add(point);
  };

  DNSVisualizer3D.prototype._applyTheme = function () {
    const dark = this.currentTheme === "dark";
    const bgColor = dark ? 0x0b1220 : 0xf6f7fb;
    this.renderer.setClearColor(bgColor, 1);

    // Adjust emissive intensity per theme
    Object.values(this.nodes).forEach(n => {
      n.material.emissiveIntensity = dark ? 0.6 : 0.25;
    });
    if (this.packet && this.packet.material)
      this.packet.material.emissiveIntensity = dark ? 0.9 : 0.5;
  };

  DNSVisualizer3D.prototype._observeTheme = function () {
    const obs = new MutationObserver(() => {
      this.currentTheme = document.documentElement.getAttribute("data-theme") || "light";
      this._applyTheme();
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  };

  DNSVisualizer3D.prototype._setupNodes = function () {
    this.nodes = {};
    const layout = {
      client: { x: -10, y: 0, z: 5, color: 0x10b981 },
      access: { x: -4, y: 2, z: 3, color: 0x8b5cf6 },
      cache: { x: -4, y: -3, z: 3, color: 0xf59e0b },
      root: { x: 2, y: 0, z: -2, color: 0x2563eb },
      tld: { x: 7, y: 0, z: -4, color: 0x4f46e5 },
      auth: { x: 12, y: 0, z: -2, color: 0x14b8a6 },
      ip: { x: 12, y: 3, z: 3, color: 0x16a34a },
    };
    Object.entries(layout).forEach(([key, pos]) => {
      const node = this._sphere(0.8, pos.color);
      node.position.set(pos.x, pos.y, pos.z);
      node.userData.label = key;
      this.scene.add(node);
      this.nodes[key] = node;
      // Create an in-visualization label sprite for this node (hidden by default)
      const title = (NODE_INFO[key] && NODE_INFO[key].title) || key;
      const sprite = this._createLabelSprite(title);
      sprite.visible = false;
      sprite.position.set(pos.x, pos.y + 1.3, pos.z);
      this.scene.add(sprite);
      this.labels[key] = sprite;
    });

    // Use a muted slate tone in dark mode so it's visible but not dominant
    const gridColor = this.currentTheme === "dark" ? 0x334155 : 0xe2e8f0;
    const grid = new THREE.GridHelper(60, 60, gridColor, gridColor);
    grid.position.y = -5.5;
    // Light, thin-looking grid
    try {
      const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
      mats.forEach(m => { m.transparent = true; m.opacity = 0.16; m.depthWrite = false; });
    } catch (_) {}
    this.scene.add(grid);
  };

  DNSVisualizer3D.prototype._curveBetween = function (a, b) {
    const start = this.nodes[a].position.clone();
    const end = this.nodes[b].position.clone();
    const mid = start.clone().lerp(end, 0.5);
    mid.y += 2.5;
    return new THREE.CatmullRomCurve3([start, mid, end]);
  };

  DNSVisualizer3D.prototype._buildCurves = function () {
    this.curves = {
      client_access: this._curveBetween("client", "access"),
      access_cache: this._curveBetween("access", "cache"),
      cache_root: this._curveBetween("cache", "root"),
      root_tld: this._curveBetween("root", "tld"),
      tld_auth: this._curveBetween("tld", "auth"),
      auth_ip: this._curveBetween("auth", "ip"),
      cache_ip: this._curveBetween("cache", "ip"),
    };
  };

  // Create a text sprite for labeling nodes in-scene
  DNSVisualizer3D.prototype._createLabelSprite = function (text, style) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const padding = 8;
    const fontSize = 22;
    ctx.font = `${fontSize}px Inter, Arial, sans-serif`;
    const lines = String(text || '').split('\n');
    const width = Math.max(...lines.map(line => ctx.measureText(line).width)) + padding * 2;
    const height = fontSize * lines.length + padding * 2;
    canvas.width = Math.ceil(width);
    canvas.height = Math.ceil(height);
    // Re-set font after resizing canvas
    ctx.font = `${fontSize}px Inter, Arial, sans-serif`;
    // Background
    const dark = this.currentTheme === 'dark';
    const isDanger = style === 'danger';
    ctx.fillStyle = isDanger ? 'rgba(220,38,38,0.9)' : (dark ? 'rgba(17,24,39,0.85)' : 'rgba(255,255,255,0.9)');
    ctx.strokeStyle = isDanger ? 'rgba(185,28,28,0.9)' : (dark ? 'rgba(148,163,184,0.5)' : 'rgba(100,116,139,0.5)');
    ctx.lineWidth = 2;
    ctx.roundRect(1, 1, canvas.width - 2, canvas.height - 2, 8);
    ctx.fill();
    ctx.stroke();
    // Text
    ctx.fillStyle = isDanger ? '#fff' : (dark ? '#e5e7eb' : '#111827');
    ctx.textBaseline = 'top';
    let y = padding;
    for (const line of lines) {
      ctx.fillText(line, padding, y);
      y += fontSize;
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    const scale = 0.008; // scale canvas px to world units
    sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
    return sprite;
  };

  DNSVisualizer3D.prototype._updateLabel = function (key, text, style) {
    const old = this.labels[key];
    if (!old) return;
    // Remove old sprite and insert new with same position
    const pos = old.position.clone();
    this.scene.remove(old);
    const next = this._createLabelSprite(text, style);
    next.position.copy(pos);
    next.visible = true;
    this.labels[key] = next;
    this.scene.add(next);
  };

  DNSVisualizer3D.prototype._showAllLabels = function () {
    // Show label with title plus any known timing for added clarity
    const t = this.timings || {};
    const byKeyExtra = {
      client: '',
      access: (typeof t.client_to_access_ms === 'number') ? `\n${t.client_to_access_ms} ms` : '',
      cache: (typeof t.access_to_cache_ms === 'number') ? `\n${t.access_to_cache_ms} ms` : '',
      root: (typeof t.cache_to_root_ms === 'number') ? `\n${t.cache_to_root_ms} ms` : '',
      tld: (typeof t.root_to_tld_ms === 'number') ? `\n${t.root_to_tld_ms} ms` : '',
      auth: (typeof t.tld_to_auth_ms === 'number') ? `\n${t.tld_to_auth_ms} ms` : '',
      ip: (typeof t.auth_to_ip_ms === 'number' || typeof t.total_ms === 'number') ? `\n${typeof t.auth_to_ip_ms==='number'?t.auth_to_ip_ms+' ms':''}${typeof t.total_ms==='number'?'\nTotal '+t.total_ms+' ms':''}` : ''
    };
    for (const key of Object.keys(this.nodes)) {
      const title = (NODE_INFO[key] && NODE_INFO[key].title) || key;
      const extra = byKeyExtra[key] || '';
      if (this.labels[key]) {
        this._updateLabel(key, `${title}${extra}`);
        this.labels[key].visible = true;
      }
    }
  };

  DNSVisualizer3D.prototype._drawPathLines = function (curveKeys = []) {
    try {
      const matColor = this.currentTheme === "dark" ? 0x60a5fa : 0x2563eb;
      for (const key of curveKeys) {
        const curve = this.curves[key];
        if (!curve) continue;
        const tubeGeo = new THREE.TubeGeometry(curve, 40, 0.05, 8, false);
        const mat = new THREE.MeshBasicMaterial({ color: matColor, transparent: true, opacity: 0.9 });
        const mesh = new THREE.Mesh(tubeGeo, mat);
        this.scene.add(mesh);
        this.pathLines.push(mesh);

        // Add small arrow cones along the path to indicate flow direction
        const coneGeo = new THREE.ConeGeometry(0.15, 0.4, 12);
        const coneMat = new THREE.MeshBasicMaterial({ color: matColor });
        const samples = 8;
        for (let i = 1; i <= samples; i++) {
          const t = i / (samples + 1);
          const pos = curve.getPointAt(t);
          const tangent = curve.getTangentAt(t).clone().normalize();
          const arrow = new THREE.Mesh(coneGeo, coneMat);
          arrow.position.copy(pos);
          // orient cone to face tangent direction
          const axis = new THREE.Vector3(0, 1, 0);
          const quat = new THREE.Quaternion().setFromUnitVectors(axis, tangent);
          arrow.quaternion.copy(quat);
          this.scene.add(arrow);
          this.pathArrows.push(arrow);
        }
      }
    } catch (_) {}
  };

  // Draw a single custom curve with specific color/opacity and keep reference
  DNSVisualizer3D.prototype._drawCurveLine = function (curve, colorHex, opacity = 0.9) {
    try {
      if (!curve) return null;
      const tubeGeo = new THREE.TubeGeometry(curve, 40, 0.05, 8, false);
      const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: opacity });
      const mesh = new THREE.Mesh(tubeGeo, mat);
      this.scene.add(mesh);
      this.pathLines.push(mesh);
      return mesh;
    } catch (_) { return null; }
  };

  // Create a small floating label near a curve midpoint
  DNSVisualizer3D.prototype._labelForCurve = function (curve, text, style) {
    try {
      if (!curve) return null;
      const spr = this._createLabelSprite(text, style);
      const mid = curve.getPointAt(0.5);
      spr.position.copy(mid.clone().add(new THREE.Vector3(0, 0.8, 0)));
      spr.visible = true;
      this.scene.add(spr);
      return spr;
    } catch (_) { return null; }
  };

  DNSVisualizer3D.prototype._setLineOpacity = function (mesh, opacity = 0.25) {
    try {
      if (mesh && mesh.material) {
        mesh.material.transparent = true;
        mesh.material.opacity = Math.max(0.05, Math.min(1, opacity));
        mesh.material.needsUpdate = true;
      }
    } catch (_) {}
  };

  DNSVisualizer3D.prototype._clearPathLines = function () {
    try {
      for (const m of this.pathLines) {
        this.scene.remove(m);
        if (m.geometry && m.geometry.dispose) m.geometry.dispose();
        if (m.material && m.material.dispose) m.material.dispose();
      }
      this.pathLines = [];
      for (const a of this.pathArrows) {
        this.scene.remove(a);
        if (a.geometry && a.geometry.dispose) a.geometry.dispose();
        if (a.material && a.material.dispose) a.material.dispose();
      }
      this.pathArrows = [];
    } catch (_) {}
  };

  DNSVisualizer3D.prototype._dimPathLines = function (opacity = 0.25) {
    try {
      const o = Math.max(0.05, Math.min(1, opacity));
      for (const m of this.pathLines) {
        if (m.material) {
          m.material.transparent = true;
          m.material.opacity = o;
          if (m.material.needsUpdate !== undefined) m.material.needsUpdate = true;
        }
      }
      for (const a of this.pathArrows) {
        if (a.material) {
          a.material.transparent = true;
          a.material.opacity = Math.min(0.4, o + 0.1);
          if (a.material.needsUpdate !== undefined) a.material.needsUpdate = true;
        }
      }
    } catch (_) {}
  };

  DNSVisualizer3D.prototype._computeNodesBounds = function () {
    const box = new THREE.Box3();
    for (const key of Object.keys(this.nodes)) {
      box.expandByPoint(this.nodes[key].position);
    }
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    return { box, center, size, radius };
  };

  DNSVisualizer3D.prototype._frameAllNodes = async function (durationSec = 0.6, padding = 1.2) {
    try {
      const { center, size, radius } = this._computeNodesBounds();
      const vFOV = (this.camera.fov * Math.PI) / 180;
      const hFOV = 2 * Math.atan(Math.tan(vFOV / 2) * this.camera.aspect);
      const distV = (size.y * padding) / (2 * Math.tan(vFOV / 2));
      const distH = (size.x * padding) / (2 * Math.tan(hFOV / 2));
      const distance = Math.max(distV, distH, radius * 1.2);
      const targetPos = new THREE.Vector3(center.x, center.y + distance * 0.25, center.z + distance * 1.1);
      if (this.controls) this.controls.target.copy(center);
      if (window.gsap) {
        await new Promise(res => {
          gsap.to(this.camera.position, { x: targetPos.x, y: targetPos.y, z: targetPos.z, duration: durationSec, ease: "power2.out", onUpdate: () => {
            if (!this.controls) this.camera.lookAt(center);
          }, onComplete: res });
        });
      } else {
        this.camera.position.copy(targetPos);
        this.camera.lookAt(center);
      }
    } catch (_) {}
  };

  // Smoothly move camera to focus on a specific node
  DNSVisualizer3D.prototype._frameNode = async function (key, durationSec = 0.6, distance = 4.0) {
    try {
      const node = this.nodes[key];
      if (!node) return;
      const target = node.position.clone();
      const dir = new THREE.Vector3(0, 1, 2).normalize();
      const pos = target.clone().add(dir.multiplyScalar(distance));
      if (this.controls) this.controls.target.copy(target);
      if (window.gsap) {
        await new Promise(res => {
          gsap.to(this.camera.position, { x: pos.x, y: pos.y, z: pos.z, duration: durationSec, ease: 'power2.out', onUpdate: () => {
            if (!this.controls) this.camera.lookAt(target);
          }, onComplete: res });
        });
      } else {
        this.camera.position.copy(pos);
        this.camera.lookAt(target);
      }
    } catch (_) {}
  };

  // Inline help for what each sphere indicates
  const NODE_INFO = {
    client: { title: "Client", body: "Your device initiating the DNS query." },
    access: { title: "Access Control", body: "Optional policy check (allowed/blocked)." },
    cache: { title: "DNS Cache", body: "Local resolver cache. If present, answer is returned quickly (TTL applies)." },
    root: { title: "Root Server", body: "Directs to the correct TLD servers (no actual answer)." },
    tld: { title: "TLD Server", body: "Points to the authoritative server for the domain." },
    auth: { title: "Authoritative Server", body: "Provides the final DNS record(s) and TTL." },
    ip: { title: "IP Address", body: "Destination address resolved from the DNS record." },
  };

  DNSVisualizer3D.prototype._showInfo = function (key, extra) {
    const el = document.getElementById("infoCard");
    if (!el) return;
    const meta = NODE_INFO[key];
    if (!meta) { el.setAttribute("hidden", ""); return; }
    const title = meta.title;
    const body = meta.body + (extra ? `\n${extra}` : "");
    el.innerHTML = `<strong>${title}</strong><div class="mt-1" style="white-space:pre-line">${body}</div>`;
    el.removeAttribute("hidden");
  };

  DNSVisualizer3D.prototype._hideInfo = function () {
    const el = document.getElementById("infoCard");
    if (!el) return;
    el.setAttribute("hidden", "");
  };

  DNSVisualizer3D.prototype._moveAlong = function (curve, duration = 1.0) {
    return new Promise(resolve => {
      if (!curve) return resolve();
      this.packet.visible = true;
      const state = { t: 0 };
      const total = duration / (this.speedMultiplier || 1);
      if (window.gsap) {
        gsap.to(state, {
          t: 1,
          duration: total,
          ease: "power1.inOut",
          onUpdate: () => {
            const pos = curve.getPointAt(state.t);
            this.packet.position.copy(pos);
            // If the packet is close to a node, show what that sphere indicates
            let nearestKey = null, nearestDist = Infinity;
            for (const [key, mesh] of Object.entries(this.nodes)) {
              const d = mesh.position.distanceTo(this.packet.position);
              if (d < nearestDist) { nearestDist = d; nearestKey = key; }
            }
            if (nearestKey && nearestDist < 1.8) {
              const title = (NODE_INFO[nearestKey] && NODE_INFO[nearestKey].title) || nearestKey;
              const context = this.currentContext ? `\n${this.currentContext}` : '';
              this._updateLabel(nearestKey, `${title}${context}`);
              const spr = this.labels[nearestKey];
              if (spr) spr.visible = true;
              this._showInfo(nearestKey);
            } else {
              // hide all labels if far
              Object.values(this.labels).forEach(s => { if (s) s.visible = false; });
              this._hideInfo();
            }
          },
          onComplete: resolve
        });
      } else {
        let t = 0;
        const steps = 60;
        const iv = setInterval(() => {
          t += 1 / steps;
          this.packet.position.copy(curve.getPointAt(Math.min(1, t)));
          if (t >= 1) { clearInterval(iv); resolve(); }
        }, (total * 1000) / steps);
      }
    });
  };

  DNSVisualizer3D.prototype._pulse = function (key, color) {
    const n = this.nodes[key];
    if (!n) return;
    const orig = n.userData.baseEmissive;
    n.material.emissive.setHex(color);
    if (window.gsap) {
      gsap.fromTo(n.scale, { x: 1, y: 1, z: 1 }, { x: 1.5, y: 1.5, z: 1.5, duration: 0.35, yoyo: true, repeat: 1 });
    }
    const prevIntensity = n.material.emissiveIntensity;
    n.material.emissiveIntensity = 1.0;
    setTimeout(() => { n.material.emissive.setHex(orig); n.material.emissiveIntensity = prevIntensity; }, 550);
  };

  // Mode: Recursive — single smooth animation with blue path styling
  DNSVisualizer3D.prototype.playRecursive = async function (trace) {
    // Run the base animation to compute steps/timings and camera work
    await this.playTrace(trace);
    // Re-style drawn path lines to a consistent blue and slightly higher opacity
    try {
      for (const m of this.pathLines) {
        if (m && m.material) {
          m.material.color && m.material.color.setHex(0x2563eb);
          m.material.transparent = true;
          m.material.opacity = 0.9;
          m.material.needsUpdate = true;
        }
      }
      // Lightly dim after a short moment to keep scene clean
      setTimeout(() => this._dimPathLines(0.3), 2200);
    } catch (_) {}
  };

  // Mode: Iterative — three distinct hops with pauses and labels
  DNSVisualizer3D.prototype.playIterative = async function (trace) {
    this.running = true;
    this.followPacket = true;
    this._clearPathLines();
    this._hideNXDomainBanner();
    this._lastTrace = trace;
    this.lastPathCurveKeys = [];
    this.timings = {};
    const segs = []; // keep segment meshes to dim progressively
    // Detect NXDOMAIN for iterative as well (stop at auth with banner)
    const itIsNX = (() => {
      try {
        const err = trace && trace.records && trace.records.error;
        const list = Array.isArray(err) ? err : (err ? [String(err)] : []);
        const joined = list.join(' ').toLowerCase();
        return joined.includes('nxdomain') || joined.includes('does not exist');
      } catch (_) { return false; }
    })();

    // Client -> Root
    this.currentContext = 'Step 1: Query Root';
    if (window.appendLog) window.appendLog(this.currentContext, 'info');
    // draw and move along: client_access, access_cache, cache_root
    const m1a = this._drawCurveLine(this.curves.client_access, 0xf59e0b, 0.95); segs.push(m1a);
    const m1b = this._drawCurveLine(this.curves.access_cache, 0xf59e0b, 0.95); segs.push(m1b);
    const m1c = this._drawCurveLine(this.curves.cache_root, 0xf59e0b, 0.95); segs.push(m1c);
    this._labelForCurve(this.curves.client_access, 'Client → Access (Policy Check)');
    this._labelForCurve(this.curves.access_cache, 'Access → Cache');
    this._labelForCurve(this.curves.cache_root, 'Step 1: Query Root');
    this.lastPathCurveKeys.push('client_access');
    this.lastPathCurveKeys.push('access_cache');
    this.lastPathCurveKeys.push('cache_root');
    { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      await this._moveAlong(this.curves.client_access, 1.0);
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now()); this.timings.client_to_access_ms = Math.round(t1 - t0);
    }
    { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      await this._moveAlong(this.curves.access_cache, 1.0);
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now()); this.timings.access_to_cache_ms = Math.round(t1 - t0);
    }
    { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      await this._moveAlong(this.curves.cache_root, 1.2);
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now()); this.timings.cache_to_root_ms = Math.round(t1 - t0);
    }
    this._pulse('root', 0xf59e0b);
    this._updateLabel('root', 'Root Server\nStep 1');
    try { await new Promise(r => setTimeout(r, 600)); } catch(_) {}
    // dim first segment slightly before next step
    this._setLineOpacity(m1a, 0.35); this._setLineOpacity(m1b, 0.35); this._setLineOpacity(m1c, 0.35);
    // Root -> TLD
    this.currentContext = 'Step 2: Query TLD';
    if (window.appendLog) window.appendLog(this.currentContext, 'info');
    const m2 = this._drawCurveLine(this.curves.root_tld, 0x9333ea, 0.95); segs.push(m2);
    this._labelForCurve(this.curves.root_tld, 'Step 2: Query TLD');
    this.lastPathCurveKeys.push('root_tld');
    { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      await this._moveAlong(this.curves.root_tld, 1.2);
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now()); this.timings.root_to_tld_ms = Math.round(t1 - t0);
    }
    this._pulse('tld', 0x9333ea);
    this._updateLabel('tld', 'TLD Server\nStep 2');
    try { await new Promise(r => setTimeout(r, 600)); } catch(_) {}
    this._setLineOpacity(m2, 0.35);
    // TLD -> Authoritative -> IP
    this.currentContext = 'Step 3: Query Authoritative';
    if (window.appendLog) window.appendLog(this.currentContext, 'info');
    const m3a = this._drawCurveLine(this.curves.tld_auth, 0x22c55e, 0.95); segs.push(m3a);
    this._labelForCurve(this.curves.tld_auth, itIsNX ? 'NXDOMAIN at Authoritative' : 'Step 3: Query Authoritative');
    this.lastPathCurveKeys.push('tld_auth');
    { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      await this._moveAlong(this.curves.tld_auth, 1.2);
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now()); this.timings.tld_to_auth_ms = Math.round(t1 - t0);
    }
    this._pulse('auth', 0x22c55e);
    this._updateLabel('auth', 'Authoritative Server\nStep 3');
    // If NXDOMAIN, stop here and show banner; else proceed to IP
    if (itIsNX) {
      this._updateLabel('auth', 'Authoritative Server\nNXDOMAIN — domain does not exist', 'danger');
      this._showNXDomainBanner('This domain does not exist');
      await this._frameNode('auth', 0.6, 4.5);
    } else {
      const m3b = this._drawCurveLine(this.curves.auth_ip, 0x22c55e, 0.95); segs.push(m3b);
      this.lastPathCurveKeys.push('auth_ip');
      { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        await this._moveAlong(this.curves.auth_ip, 1.2);
        const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now()); this.timings.auth_to_ip_ms = Math.round(t1 - t0);
      }
      this._pulse('ip', 0x16a34a);
    }
    this.running = false;
    this.followPacket = false;
    // Keep final step bright, dim earlier segments a bit more
    this._setLineOpacity(m1a, 0.25); this._setLineOpacity(m1b, 0.25); this._setLineOpacity(m1c, 0.25);
    this._setLineOpacity(m2, 0.3);
    this._showAllLabels();
    await this._frameAllNodes(0.6, 1.25);
    try { await new Promise(r => setTimeout(r, 2500)); } catch(_) {}
    this._dimPathLines(0.2);
  };

  // Mode: Multi-Path (A and AAAA in parallel; traverse hierarchy then split at Authoritative)
  DNSVisualizer3D.prototype.playMultiPath = async function (trace) {
    this.running = true;
    this.followPacket = false; // follow would pick one packet; keep overview
    this._clearPathLines();
    this._hideNXDomainBanner();
    this._lastTrace = trace;
    // Detect NXDOMAIN for multi (if backend surfaced it)
    const multiIsNX = (() => {
      try {
        const err = trace && trace.records && trace.records.error;
        const list = Array.isArray(err) ? err : (err ? [String(err)] : []);
        const joined = list.join(' ').toLowerCase();
        return joined.includes('nxdomain') || joined.includes('does not exist');
      } catch (_) { return false; }
    })();

    // Walk the DNS hierarchy first (client → access → cache → root → tld → auth)
    const segColor = this.currentTheme === 'dark' ? 0x60a5fa : 0x2563eb;
    this._drawCurveLine(this.curves.client_access, segColor, 0.9);
    this._drawCurveLine(this.curves.access_cache, segColor, 0.9);
    this._drawCurveLine(this.curves.cache_root, segColor, 0.9);
    this._drawCurveLine(this.curves.root_tld, segColor, 0.9);
    this._drawCurveLine(this.curves.tld_auth, segColor, 0.9);
    await this._moveAlong(this.curves.client_access, 0.7);
    await this._moveAlong(this.curves.access_cache, 0.7);
    this._pulse('cache', 0xf59e0b);
    await this._moveAlong(this.curves.cache_root, 0.9);
    this._pulse('root', segColor);
    await this._moveAlong(this.curves.root_tld, 0.9);
    this._pulse('tld', segColor);
    await this._moveAlong(this.curves.tld_auth, 0.9);
    this._pulse('auth', segColor);
    if (multiIsNX) {
      // Show NXDOMAIN centrally and stop at authoritative
      this._showNXDomainBanner('This domain does not exist');
      this._updateLabel('auth', 'Authoritative Server\nNXDOMAIN — domain does not exist', 'danger');
      await this._frameNode('auth', 0.6, 4.5);
      return;
    }
    // Create a second packet for AAAA
    const pktA = this.packet;
    const pktAAAA = this.packet.clone();
    pktA.visible = true;
    pktAAAA.visible = true;
    // Colors
    try { pktA.material = new THREE.MeshPhongMaterial({ color: 0x16a34a, emissive: 0x14532d, emissiveIntensity: 0.8 }); } catch(_) {}
    try { pktAAAA.material = new THREE.MeshPhongMaterial({ color: 0x2563eb, emissive: 0x1e3a8a, emissiveIntensity: 0.8 }); } catch(_) {}
    this.scene.add(pktAAAA);
    // Two terminal branches from Authoritative to IP: base and a slightly offset variant
    const curveA = this.curves.auth_ip;
    const offsetCurve = (() => {
      const base = this.curves.auth_ip;
      const pts = base.getPoints(40).map(p => p.clone());
      pts.forEach((p, i) => { p.x += Math.sin(i / 6) * 0.2; p.y += Math.cos(i / 7) * 0.1; });
      return new THREE.CatmullRomCurve3(pts);
    })();
    // Draw both path lines upfront (distinct colors)
    const meshA = this._drawCurveLine(curveA, 0x16a34a, 0.95);   // green
    const meshAAAA = this._drawCurveLine(offsetCurve, 0x2563eb, 0.85); // blue
    // Label the two paths
    const lblA = this._labelForCurve(curveA, 'A (IPv4)');
    const lblAAAA = this._labelForCurve(offsetCurve, 'AAAA (IPv6)');
    // Animate both
    await new Promise(resolve => {
      let done = 0;
      const finish = () => { done++; if (done === 2) resolve(); };
      const movePacket = (packet, curve, duration) => {
        const state = { t: 0 };
        if (window.gsap) {
          gsap.to(state, { t: 1, duration, ease: 'power1.inOut', onUpdate: () => {
            const pos = curve.getPointAt(state.t);
            packet.position.copy(pos);
          }, onComplete: finish });
        } else { finish(); }
      };
      movePacket(pktA, curveA, 1.4 / (this.speedMultiplier || 1));
      movePacket(pktAAAA, offsetCurve, 1.6 / (this.speedMultiplier || 1));
    });
    // Highlight winner if provided (color emphasis & dim loser)
    const faster = (trace.multi && trace.multi.faster) || '-';
    if (faster === 'A') {
      if (meshA && meshA.material) { meshA.material.opacity = 1.0; meshA.material.needsUpdate = true; }
      if (meshAAAA && meshAAAA.material) { meshAAAA.material.opacity = 0.25; meshAAAA.material.needsUpdate = true; }
      this._pulse('ip', 0x16a34a);
    } else if (faster === 'AAAA') {
      if (meshAAAA && meshAAAA.material) { meshAAAA.material.opacity = 1.0; meshAAAA.material.needsUpdate = true; }
      if (meshA && meshA.material) { meshA.material.opacity = 0.25; meshA.material.needsUpdate = true; }
      this._pulse('ip', 0x2563eb);
    }
    // Cleanup cloned packet
    try { this.scene.remove(pktAAAA); pktAAAA.geometry.dispose?.(); pktAAAA.material.dispose?.(); } catch(_) {}
    this.running = false;
    this._showAllLabels();
    await this._frameAllNodes(0.6, 1.25);
    // Keep both custom lines; hierarchy lines already drawn above
    try { await new Promise(r => setTimeout(r, 2000)); } catch(_) {}
    this._dimPathLines(0.25);
  };

  DNSVisualizer3D.prototype.playTrace = async function (trace) {
    this.running = true;
    this._autoRotateSaved = this.autoRotate;
    this.autoRotate = false; // prevent random rotation while following packet
    this.followPacket = true;
    // Clear any previous path visuals before a new run
    this._clearPathLines();
    this._hideNXDomainBanner();
    this._lastTrace = trace;
    let reachedDestination = false;
    this.lastPathCurveKeys = [];
    let wasBlocked = false;
    this.timings = { totalStart: (typeof performance !== 'undefined' ? performance.now() : Date.now()) };
    const isNXDomain = (() => {
      try {
        const err = trace && trace.records && trace.records.error;
        const list = Array.isArray(err) ? err : (err ? [String(err)] : []);
        const joined = list.join(' ').toLowerCase();
        return joined.includes('nxdomain') || joined.includes('does not exist');
      } catch (_) { return false; }
    })();

    for (const s of trace.steps || []) {
      if (s.name === "access_control") {
        this.currentContext = "Policy check";
        const isBlocked = s.status === "blocked";
        this._pulse("access", isBlocked ? 0xef4444 : 0x22c55e);
        if (window.appendLog) window.appendLog("Access control check performed", "info");
        if (isBlocked) {
          // Move up to Access, then show Restricted state and stop
          try { await this._moveAlong(this.curves.client_access, 1.0); } catch(_) {}
          this.currentContext = "Restricted — blocked by policy";
          this._updateLabel("access", `Access Control\n${this.currentContext}` , 'danger');
          const spr = this.labels["access"]; if (spr) spr.visible = true;
          this._showInfo("access");
          try { await new Promise(r => setTimeout(r, 1200)); } catch(_) {}
          wasBlocked = true;
          break;
        }
      }
      if (s.name === "cache_lookup") {
        if (s.status === "hit") {
          this.currentContext = "Cache HIT";
          if (window.appendLog) window.appendLog("Cache hit — returning cached result", "success");
          { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.lastPathCurveKeys.push('client_access');
            await this._moveAlong(this.curves.client_access, 1.2);
            const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.timings.client_to_access_ms = Math.round(t1 - t0);
          }
          { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.lastPathCurveKeys.push('cache_ip');
            await this._moveAlong(this.curves.cache_ip, 1.6);
            const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.timings.cache_to_ip_ms = Math.round(t1 - t0);
          }
          this._pulse("cache", 0xf59e0b);
          this._pulse("ip", 0x16a34a);
          reachedDestination = true;
          this._updateLabel("cache", `DNS Cache\nHIT`);
          const sprC = this.labels["cache"]; if (sprC) sprC.visible = true;
        } else {
          this.currentContext = "Cache MISS";
          if (window.appendLog) window.appendLog("Cache miss — querying DNS hierarchy", "info");
          { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.lastPathCurveKeys.push('client_access');
            await this._moveAlong(this.curves.client_access, 1.2);
            const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.timings.client_to_access_ms = Math.round(t1 - t0);
          }
          { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.lastPathCurveKeys.push('access_cache');
            await this._moveAlong(this.curves.access_cache, 1.2);
            const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.timings.access_to_cache_ms = Math.round(t1 - t0);
          }
          this.currentContext = "Querying Root server";
          if (window.appendLog) window.appendLog("Querying Root server", "info");
          { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.lastPathCurveKeys.push('cache_root');
            await this._moveAlong(this.curves.cache_root, 1.4);
            const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.timings.cache_to_root_ms = Math.round(t1 - t0);
            this._updateLabel("root", `Root Server\n${this.timings.cache_to_root_ms} ms`);
          }
          this.currentContext = "Querying TLD server";
          if (window.appendLog) window.appendLog("Querying TLD server", "info");
          { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.lastPathCurveKeys.push('root_tld');
            await this._moveAlong(this.curves.root_tld, 1.4);
            const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.timings.root_to_tld_ms = Math.round(t1 - t0);
            this._updateLabel("tld", `TLD Server\n${this.timings.root_to_tld_ms} ms`);
          }
          this.currentContext = "Querying Authoritative server";
          if (window.appendLog) window.appendLog("Querying Authoritative server", "info");
          { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.lastPathCurveKeys.push('tld_auth');
            await this._moveAlong(this.curves.tld_auth, 1.4);
            const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            this.timings.tld_to_auth_ms = Math.round(t1 - t0);
            this._updateLabel("auth", `Authoritative Server\n${this.timings.tld_to_auth_ms} ms`);
          }
          if (isNXDomain) {
            // Stop here and show NXDOMAIN message at Authoritative
            this.currentContext = "NXDOMAIN — domain does not exist";
            this._updateLabel("auth", `Authoritative Server\nNXDOMAIN — domain does not exist`, 'danger');
            const sprA = this.labels["auth"]; if (sprA) sprA.visible = true;
            this._pulse("auth", 0xef4444);
            this._showNXDomainBanner('This domain does not exist');
            try { await this._frameNode('auth', 0.6, 4.5); } catch(_) {}
            reachedDestination = true; // to allow path draw and framing
            if (window.appendLog) window.appendLog("NXDOMAIN — domain does not exist", "error");
          } else {
            this.currentContext = "Returning final answer";
            { const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
              this.lastPathCurveKeys.push('auth_ip');
              await this._moveAlong(this.curves.auth_ip, 1.6);
              const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
              this.timings.auth_to_ip_ms = Math.round(t1 - t0);
            }
            this._pulse("ip", 0x16a34a);
            reachedDestination = true;
            if (window.appendLog) window.appendLog("Resolved final IP address", "success");
          }
        }
      }
    }
    this.followPacket = false;
    this.currentContext = "";
    this.running = false;
    if (reachedDestination) {
      // Show all nodes/labels, frame everything, draw the taken path, keep visible but dim after 3s
      this._showAllLabels();
      await this._frameAllNodes(0.6, 1.25);
      this._drawPathLines(this.lastPathCurveKeys);
      try { await new Promise(r => setTimeout(r, 3000)); } catch(_) {}
      this._dimPathLines(0.2);
    }
    // Finalize total timing and resume auto-rotate after summary (not for blocked cases)
    this.timings.totalEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.timings.total_ms = Math.round(this.timings.totalEnd - this.timings.totalStart);
    this.autoRotate = !wasBlocked;
  };

  DNSVisualizer3D.prototype.setSpeed = function (v) { this.speedMultiplier = v || 1; };
  DNSVisualizer3D.prototype.setAutoRotate = function (f) { this.autoRotate = !!f; };
  DNSVisualizer3D.prototype.pause = function () { if (window.gsap) gsap.globalTimeline.pause(); };
  DNSVisualizer3D.prototype.resume = function () { if (window.gsap) gsap.globalTimeline.resume(); };
  DNSVisualizer3D.prototype.replay = function () { if (this._lastTrace) this.playTrace(this._lastTrace); };
  DNSVisualizer3D.prototype._onResize = function () {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  window.DNSVisualizer3D = DNSVisualizer3D;
})();
