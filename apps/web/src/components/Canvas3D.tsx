import { useRef, useEffect, useState } from 'react';

interface Canvas3DProps {
  model: any | null;
  result: any | null;
}

export default function Canvas3D({ model, result }: Canvas3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [angleX, setAngleX] = useState(-0.6); // Rotation around Y
  const [angleY, setAngleY] = useState(0.3);  // Rotation around X
  const [zoom, setZoom] = useState(1.1);

  // Drag interaction logic
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;

      setAngleX(prev => prev + dx * 0.007);
      setAngleY(prev => Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, prev - dy * 0.007)));
    };

    const handleMouseUp = () => {
      isDragging = false;
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(prev => Math.max(0.3, Math.min(4.0, prev - e.deltaY * 0.001)));
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    // Touch support for mobile devices
    let touchStartX = 0;
    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        isDragging = true;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;

      setAngleX(prev => prev + dx * 0.007);
      setAngleY(prev => Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, prev - dy * 0.007)));
    };
    const handleTouchEnd = () => {
      isDragging = false;
    };

    canvas.addEventListener('touchstart', handleTouchStart);
    canvas.addEventListener('touchmove', handleTouchMove);
    canvas.addEventListener('touchend', handleTouchEnd);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
    };
  }, []);

  // Main rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Slate 950 premium background
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);

    const project = (x: number, y: number, z: number) => {
      // Rotation around Y (horizontal)
      const x1 = x * Math.cos(angleX) - z * Math.sin(angleX);
      const z1 = x * Math.sin(angleX) + z * Math.cos(angleX);

      // Rotation around X (vertical)
      const y2 = y * Math.cos(angleY) - z1 * Math.sin(angleY);
      const z2 = y * Math.sin(angleY) + z1 * Math.cos(angleY);

      const distance = 400;
      const scale = 220 * zoom;

      const xs = w / 2 + (x1 * scale) / (z2 + distance);
      const ys = h / 2 - (y2 * scale) / (z2 + distance);

      return { x: xs, y: ys, zDepth: z2 };
    };

    const geometry = model?.geometry;
    const nodes: any[] = geometry?.nodes || [];
    const elements: any[] = geometry?.elements || [];

    // Find bounding box to center model
    let minX = 0, maxX = 0, minY = 0, maxY = 0, minZ = 0, maxZ = 0;
    if (nodes.length > 0) {
      minX = Math.min(...nodes.map(n => n.x));
      maxX = Math.max(...nodes.map(n => n.x));
      minY = Math.min(...nodes.map(n => n.y));
      maxY = Math.max(...nodes.map(n => n.y));
      minZ = Math.min(...nodes.map(n => n.z));
      maxZ = Math.max(...nodes.map(n => n.z));
    }

    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const midZ = (minZ + maxZ) / 2;

    const scaleFactor = 15.0; // Spatial scaling factor

    // 1. Draw Grid (Z-plane at Y=0)
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.4)';
    ctx.lineWidth = 1;
    const gridSize = 10;
    const gridSpacing = 8;
    for (let i = -gridSize; i <= gridSize; i++) {
      const p1 = project(i * gridSpacing, (0 - midY) * scaleFactor, -gridSize * gridSpacing);
      const p2 = project(i * gridSpacing, (0 - midY) * scaleFactor, gridSize * gridSpacing);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      const p3 = project(-gridSize * gridSpacing, (0 - midY) * scaleFactor, i * gridSpacing);
      const p4 = project(gridSize * gridSpacing, (0 - midY) * scaleFactor, i * gridSpacing);
      ctx.beginPath();
      ctx.moveTo(p3.x, p3.y);
      ctx.lineTo(p4.x, p4.y);
      ctx.stroke();
    }

    // 2. Draw Coordinates Axes
    const axisLen = 50;
    const pCenter = project((0 - midX) * scaleFactor, (0 - midY) * scaleFactor, (0 - midZ) * scaleFactor);
    const pX = project((axisLen - midX) * scaleFactor, (0 - midY) * scaleFactor, (0 - midZ) * scaleFactor);
    const pY = project((0 - midX) * scaleFactor, (axisLen - midY) * scaleFactor, (0 - midZ) * scaleFactor);
    const pZ = project((0 - midX) * scaleFactor, (0 - midY) * scaleFactor, (axisLen - midZ) * scaleFactor);

    // X Axis (Red)
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(pCenter.x, pCenter.y); ctx.lineTo(pX.x, pX.y); ctx.stroke();
    ctx.fillStyle = '#ef4444'; ctx.font = '10px monospace'; ctx.fillText('X', pX.x + 5, pX.y + 5);

    // Y Axis (Green)
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath(); ctx.moveTo(pCenter.x, pCenter.y); ctx.lineTo(pY.x, pY.y); ctx.stroke();
    ctx.fillStyle = '#22c55e'; ctx.fillText('Y', pY.x + 5, pY.y - 5);

    // Z Axis (Blue)
    ctx.strokeStyle = '#3b82f6';
    ctx.beginPath(); ctx.moveTo(pCenter.x, pCenter.y); ctx.lineTo(pZ.x, pZ.y); ctx.stroke();
    ctx.fillStyle = '#3b82f6'; ctx.fillText('Z', pZ.x + 5, pZ.y + 5);

    // 3. Process and render elements with Depth Cueing & Bending Moments
    if (nodes.length > 0) {
      const elementsWithDepth = elements.map(el => {
        const n1 = nodes.find(n => n.id === el.start_node_id);
        const n2 = nodes.find(n => n.id === el.end_node_id);
        if (!n1 || !n2) return null;

        // Start & End projected coordinates (undeformed)
        const p1 = project((n1.x - midX) * scaleFactor, (n1.y - midY) * scaleFactor, (n1.z - midZ) * scaleFactor);
        const p2 = project((n2.x - midX) * scaleFactor, (n2.y - midY) * scaleFactor, (n2.z - midZ) * scaleFactor);

        // Projected deformed coordinates
        let dp1 = p1;
        let dp2 = p2;
        if (result && result.nodes) {
          const resN1 = result.nodes.find((rn: any) => rn.id === n1.id);
          const resN2 = result.nodes.find((rn: any) => rn.id === n2.id);
          if (resN1 && resN2) {
            // Apply exaggeration scale of 100 for displacements visual clarity
            const exag = 100.0;
            dp1 = project(
              (n1.x + (resN1.ux / 1000.0) * exag - midX) * scaleFactor,
              (n1.y + (resN1.uy / 1000.0) * exag - midY) * scaleFactor,
              (n1.z + (resN1.uz / 1000.0) * exag - midZ) * scaleFactor
            );
            dp2 = project(
              (n2.x + (resN2.ux / 1000.0) * exag - midX) * scaleFactor,
              (n2.y + (resN2.uy / 1000.0) * exag - midY) * scaleFactor,
              (n2.z + (resN2.uz / 1000.0) * exag - midZ) * scaleFactor
            );
          }
        }

        const avgDepth = (p1.zDepth + p2.zDepth) / 2;
        return { el, p1, p2, dp1, dp2, avgDepth, n1, n2 };
      }).filter(x => x !== null) as any[];

      // Painter's algorithm: sort elements back-to-front
      elementsWithDepth.sort((a, b) => b.avgDepth - a.avgDepth);

      // Render elements and Bending Moment Diagrams (BMD)
      elementsWithDepth.forEach(({ el, p1, p2, dp1, dp2, avgDepth, n1, n2 }) => {
        // Calculate Depth Cueing brightness (1.0 is closest, 0.25 is furthest)
        const maxDist = 300;
        const normDepth = Math.max(0, Math.min(1, (avgDepth + maxDist / 2) / maxDist));
        const brightness = Math.max(0.25, Math.min(1.0, 1.1 - normDepth));

        const isBrace = el.id.includes('Brace');
        const isPurlin = el.id.includes('Purlin') || el.id.includes('Girt');

        // Draw structural member (undeformed element as dotted or solid background line)
        ctx.strokeStyle = 'rgba(51, 65, 85, ' + (brightness * 0.3) + ')';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]); // Reset

        // Draw deformed structure member (main glowing view)
        ctx.shadowColor = isBrace ? '#f97316' : isPurlin ? '#3b82f6' : '#a855f7';
        ctx.shadowBlur = result ? 8 * brightness : 0;
        
        // HSL tailored palette
        ctx.strokeStyle = isBrace 
          ? `hsla(24, 95%, 53%, ${brightness})` 
          : isPurlin 
            ? `hsla(217, 91%, 60%, ${brightness * 0.8})` 
            : `hsla(271, 91%, 65%, ${brightness})`;

        ctx.lineWidth = isBrace ? 2 : isPurlin ? 2.5 : 4;
        ctx.beginPath();
        ctx.moveTo(dp1.x, dp1.y);
        ctx.lineTo(dp2.x, dp2.y);
        ctx.stroke();

        ctx.shadowBlur = 0; // Reset glow

        // Draw Bending Moment 3D Shaded Ribbons
        const resEl = result?.elements?.find((r: any) => r.id === el.id);
        if (resEl && !isBrace && !isPurlin) {
          // Exaggeration scale for visual clarity of moments
          const scaleMoment = 0.5; 
          const mStart = resEl.mz_start * scaleMoment;
          const mEnd = resEl.mz_end * scaleMoment;

          // Offsets: Columns offset along global X; Rafters offset along global Y
          const isCol = el.id.includes('Col');
          const offsetX = isCol ? 0.35 : 0;
          const offsetY = isCol ? 0 : 0.35;

          const offsetP1 = project(
            (n1.x + offsetX * mStart - midX) * scaleFactor,
            (n1.y + offsetY * mStart - midY) * scaleFactor,
            (n1.z - midZ) * scaleFactor
          );
          const offsetP2 = project(
            (n2.x + offsetX * mEnd - midX) * scaleFactor,
            (n2.y + offsetY * mEnd - midY) * scaleFactor,
            (n2.z - midZ) * scaleFactor
          );

          // Draw the physical shaded ribbon
          ctx.fillStyle = isCol 
            ? `hsla(0, 84%, 60%, ${brightness * 0.15})` 
            : `hsla(142, 70%, 45%, ${brightness * 0.15})`;

          ctx.strokeStyle = isCol 
            ? `hsla(0, 84%, 60%, ${brightness * 0.7})` 
            : `hsla(142, 70%, 45%, ${brightness * 0.7})`;

          ctx.lineWidth = 1.2;

          ctx.beginPath();
          ctx.moveTo(dp1.x, dp1.y);
          ctx.lineTo(offsetP1.x, offsetP1.y);
          ctx.lineTo(offsetP2.x, offsetP2.y);
          ctx.lineTo(dp2.x, dp2.y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          // Render values on the ribbons
          if (brightness > 0.6) {
            ctx.fillStyle = '#f8fafc';
            ctx.font = '8px monospace';
            if (Math.abs(resEl.mz_start) > 0.5) {
              ctx.fillText(`${resEl.mz_start.toFixed(1)} kNm`, offsetP1.x + 5, offsetP1.y);
            }
          }
        }
      });

      // 4. Draw Nodal support markers
      nodes.forEach(n => {
        const px = project((n.x - midX) * scaleFactor, (n.y - midY) * scaleFactor, (n.z - midZ) * scaleFactor);
        if (n.support_type === 'Fixed') {
          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.arc(px.x, px.y, 4, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(px.x - 8, px.y + 4);
          ctx.lineTo(px.x + 8, px.y + 4);
          ctx.stroke();
        }
      });
    }

  }, [model, result, angleX, angleY, zoom]);

  const maxDisp = result && result.nodes && result.nodes.length > 0
    ? Math.max(...result.nodes.map((rn: any) => Math.sqrt(rn.ux*rn.ux + rn.uy*rn.uy + rn.uz*rn.uz)))
    : 0.0;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas 
        ref={canvasRef} 
        style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab' }}
      />
      
      {/* 3D Real-time Technical HUD Overlay */}
      <div style={{
        position: 'absolute',
        top: '20px',
        left: '20px',
        background: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(139, 92, 246, 0.25)',
        padding: '16px',
        borderRadius: '12px',
        boxShadow: '0 10px 30px -10px rgba(0, 0, 0, 0.6)',
        maxWidth: '300px',
        color: '#f8fafc',
        pointerEvents: 'none'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <span style={{ fontSize: '18px' }}>⚡</span>
          <span style={{ fontWeight: 'bold', fontSize: '12px', color: '#c4b5fd', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Silnik MES 3D Aktywny
          </span>
        </div>
        <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.5, marginBottom: '12px' }}>
          Parametry ramy portalowej przeliczane na żywo z pełną macierzą sztywności ramy przestrzennej 12x12.
        </div>
        
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Liczba węzłów:</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>{model?.geometry?.nodes?.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Pręty ramy:</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>{model?.geometry?.elements?.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Maks. ugięcie:</span>
              <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>{maxDisp.toFixed(1)} mm</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Obciążenie pionowe:</span>
              <span style={{ color: '#ef4444', fontWeight: 'bold' }}>-25.0 kN / węzeł</span>
            </div>
          </div>
        )}
      </div>

      {/* Control instructions bottom-right */}
      <div style={{
        position: 'absolute',
        bottom: '20px',
        right: '20px',
        background: 'rgba(15, 23, 42, 0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        padding: '6px 12px',
        borderRadius: '6px',
        fontSize: '10px',
        color: '#64748b',
        pointerEvents: 'none',
        border: '1px solid rgba(255,255,255,0.05)'
      }}>
        🖱 Lewy przycisk myszy: Obrót | 📜 Wheel: Zoom
      </div>
    </div>
  );
}
