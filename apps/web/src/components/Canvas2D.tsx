import { useRef, useEffect, useCallback, useState } from 'react';

// =============================================================================
// Types matching the Rust solver output
// =============================================================================

export interface ResultPoint {
  global_x: number;
  deflection: number; // in mm
  moment: number;     // in kNm
  shear: number;      // in kN
}

export interface Support {
  id: string;
  x: number;
  type: 'Pinned' | 'Fixed';
}

export interface PointLoad {
  id: string;
  x: number;
  value: number; // kN
}

interface Canvas2DProps {
  results: ResultPoint[] | null;
  supports: Support[];
  pointLoads: PointLoad[];
  beamLength: number;
  load: number;
  activeTool: 'select' | 'draw_beam' | 'add_point_load' | 'add_support';
  setBeamLength: (length: number) => void;
  setActiveTool: (tool: 'select' | 'draw_beam' | 'add_point_load' | 'add_support') => void;
}

// =============================================================================
// Canvas Drawing Engine
// =============================================================================

// Color palette matching premium dark design
const COLORS = {
  beam: '#e2e8f0',
  beamStroke: '#94a3b8',
  support: '#3b82f6',
  supportFill: 'rgba(59, 130, 246, 0.15)',
  load: '#ef4444',
  loadArrow: '#fca5a5',
  moment: '#8b5cf6',
  momentFill: 'rgba(139, 92, 246, 0.12)',
  shear: '#06b6d4',
  shearFill: 'rgba(6, 182, 212, 0.12)',
  deflection: '#f59e0b',
  deflectionFill: 'rgba(245, 158, 11, 0.12)',
  grid: 'rgba(148, 163, 184, 0.05)',
  gridMajor: 'rgba(148, 163, 184, 0.1)',
  axis: 'rgba(148, 163, 184, 0.2)',
  text: '#94a3b8',
  textBright: '#e2e8f0',
  dimLine: 'rgba(148, 163, 184, 0.25)',
};

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  // Minor grid
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 0.5;
  const gridSize = 20;
  for (let x = 0; x < w; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // Major grid
  ctx.strokeStyle = COLORS.gridMajor;
  ctx.lineWidth = 0.5;
  const majorSize = 100;
  for (let x = 0; x < w; x += majorSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += majorSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number, fromY: number,
  toX: number, toY: number,
  headLen: number = 8,
) {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLen * Math.cos(angle - Math.PI / 6),
    toY - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    toX - headLen * Math.cos(angle + Math.PI / 6),
    toY - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

function drawPinnedSupport(ctx: CanvasRenderingContext2D, x: number, y: number, size: number = 20) {
  // Triangle
  ctx.strokeStyle = COLORS.support;
  ctx.fillStyle = COLORS.supportFill;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * 0.6, y + size);
  ctx.lineTo(x + size * 0.6, y + size);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Hatch lines under support base plate
  ctx.strokeStyle = COLORS.support;
  ctx.lineWidth = 1;
  const baseY = y + size;
  ctx.beginPath();
  ctx.moveTo(x - size * 0.8, baseY + 3);
  ctx.lineTo(x + size * 0.8, baseY + 3);
  ctx.stroke();
  for (let i = -3; i <= 3; i++) {
    const hx = x + i * (size * 0.2);
    ctx.beginPath();
    ctx.moveTo(hx, baseY + 3);
    ctx.lineTo(hx - 4, baseY + 9);
    ctx.stroke();
  }
}

function drawFixedSupportEdge(ctx: CanvasRenderingContext2D, x: number, y: number, isRightSide: boolean, size: number = 20) {
  ctx.strokeStyle = COLORS.support;
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'square';
  
  // Vertical heavy wall
  ctx.beginPath();
  ctx.moveTo(x, y - size * 0.7);
  ctx.lineTo(x, y + size * 0.7);
  ctx.stroke();

  // Concrete hatches
  ctx.lineWidth = 1;
  const hatchSpacing = 4;
  const hatchLen = 6;
  const factor = isRightSide ? 1 : -1;
  
  for (let hy = y - size * 0.6; hy <= y + size * 0.6; hy += hatchSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, hy);
    ctx.lineTo(x + factor * hatchLen, hy - hatchLen);
    ctx.stroke();
  }
}

function drawFixedSupportIntermediate(ctx: CanvasRenderingContext2D, x: number, y: number, size: number = 20) {
  ctx.strokeStyle = COLORS.support;
  ctx.fillStyle = COLORS.supportFill;
  ctx.lineWidth = 3.5;
  
  // Rigid heavy horizontal plate just under the beam
  ctx.beginPath();
  ctx.moveTo(x - size * 0.6, y);
  ctx.lineTo(x + size * 0.6, y);
  ctx.stroke();

  // Downward hatches
  ctx.lineWidth = 1;
  for (let hx = x - size * 0.5; hx <= x + size * 0.5; hx += 4) {
    ctx.beginPath();
    ctx.moveTo(hx, y);
    ctx.lineTo(hx - 4, y + 8);
    ctx.stroke();
  }
}

function drawMeshDiagram(
  ctx: CanvasRenderingContext2D,
  points: ResultPoint[],
  field: 'deflection' | 'moment' | 'shear',
  startX: number, baseY: number, beamLength: number, beamPixelLen: number,
  scale: number,
  color: string, fillColor: string,
  label: string,
  invertSign: boolean = false,
) {
  if (points.length === 0) return;

  // Fill area under curve
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.moveTo(startX, baseY);
  
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const px = startX + (p.global_x / beamLength) * beamPixelLen;
    const val = invertSign ? -p[field] : p[field];
    const py = baseY - val * scale;
    ctx.lineTo(px, py);
  }
  
  ctx.lineTo(startX + beamPixelLen, baseY);
  ctx.closePath();
  ctx.fill();

  // Stroke curve line
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const px = startX + (p.global_x / beamLength) * beamPixelLen;
    const val = invertSign ? -p[field] : p[field];
    const py = baseY - val * scale;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Axis baseline
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(startX, baseY);
  ctx.lineTo(startX + beamPixelLen, baseY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Find extreme values and their points
  const values = points.map(p => p[field]);
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);

  ctx.fillStyle = color;
  ctx.font = `600 11px 'JetBrains Mono', monospace`;
  
  // Render max label if substantial
  const maxIdx = values.indexOf(maxVal);
  if (maxIdx >= 0 && Math.abs(maxVal) > 1e-2) {
    const p = points[maxIdx];
    const px = startX + (p.global_x / beamLength) * beamPixelLen;
    const val = invertSign ? -maxVal : maxVal;
    const py = baseY - val * scale;
    ctx.textAlign = 'center';
    ctx.fillText(maxVal.toFixed(2), px, py + (val >= 0 ? -6 : 14));
  }

  // Render min label if substantial and distinct
  const minIdx = values.indexOf(minVal);
  if (minIdx >= 0 && minIdx !== maxIdx && Math.abs(minVal) > 1e-2) {
    const p = points[minIdx];
    const px = startX + (p.global_x / beamLength) * beamPixelLen;
    const val = invertSign ? -minVal : minVal;
    const py = baseY - val * scale;
    ctx.textAlign = 'center';
    ctx.fillText(minVal.toFixed(2), px, py + (val >= 0 ? -6 : 14));
  }

  // Diagram Label
  ctx.fillStyle = color;
  ctx.font = `700 12px 'Inter', sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(label, startX - 5, baseY - 50);
}

// =============================================================================
// Canvas2D Component
// =============================================================================

export default function Canvas2D({ 
  results, 
  supports, 
  pointLoads, 
  beamLength, 
  load,
  activeTool,
  setBeamLength,
  setActiveTool
}: Canvas2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<{ x: number; y: number }[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Auto-dismiss toast message after 2.5s
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 2500);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  const getTouchCoords = (e: React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || e.touches.length === 0) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.touches[0].clientX - rect.left,
      y: e.touches[0].clientY - rect.top
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool !== 'draw_beam') return;
    const coords = getCanvasCoords(e);
    setIsDrawing(true);
    setCurrentStroke([coords]);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool !== 'draw_beam' || !isDrawing) return;
    const coords = getCanvasCoords(e);
    setCurrentStroke(prev => [...prev, coords]);
  };

  const handleMouseUp = () => {
    if (activeTool !== 'draw_beam' || !isDrawing) return;
    setIsDrawing(false);

    if (currentStroke.length >= 2) {
      const xs = currentStroke.map(p => p.x);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const pixelWidth = maxX - minX;

      // Only trigger if line is drawn at least 40px wide to avoid accidental clicks
      if (pixelWidth >= 40) {
        const canvas = canvasRef.current;
        if (canvas) {
          const w = canvas.clientWidth;
          const beamPixelLen = w - 160; // 80 left margin + 80 right margin
          const pixelsPerMeter = beamPixelLen / beamLength;
          let newLen = pixelWidth / pixelsPerMeter;
          newLen = Math.round(newLen * 2.0) / 2.0; // round to nearest 0.5m
          newLen = Math.max(1.0, Math.min(20.0, newLen)); // clamp between 1.0m and 20.0m

          setBeamLength(newLen);
          setToastMessage(`✏️ Wykryto odręczny szkic belki: L = ${newLen.toFixed(1)} m`);
        }
      }
    }

    setCurrentStroke([]);
    setActiveTool('select');
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (activeTool !== 'draw_beam') return;
    e.preventDefault(); // prevent scroll
    const coords = getTouchCoords(e);
    setIsDrawing(true);
    setCurrentStroke([coords]);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (activeTool !== 'draw_beam' || !isDrawing) return;
    e.preventDefault();
    const coords = getTouchCoords(e);
    setCurrentStroke(prev => [...prev, coords]);
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (activeTool !== 'draw_beam' || !isDrawing) return;
    e.preventDefault();
    handleMouseUp();
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const parent = canvas.parentElement;
    if (!parent) return;

    const w = parent.clientWidth;
    const h = parent.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Minor/major background grid
    drawGrid(ctx, w, h);

    // Sizing and layout
    const margin = { left: 80, right: 80, top: 60, bottom: 60 };
    const beamY = margin.top + 60;
    const beamPixelLen = w - margin.left - margin.right;
    const startX = margin.left;
    const endX = startX + beamPixelLen;

    // ======== Draw Beam Body ========
    ctx.strokeStyle = COLORS.beamStroke;
    ctx.fillStyle = COLORS.beam;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    // Premium glowing beam shadow
    ctx.shadowColor = 'rgba(59, 130, 246, 0.12)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(startX, beamY);
    ctx.lineTo(endX, beamY);
    ctx.stroke();
    ctx.shadowBlur = 0; // reset shadow

    // Thick steel beam rectangle representation
    const beamThick = 8;
    ctx.fillStyle = COLORS.beam;
    ctx.beginPath();
    ctx.roundRect(startX, beamY - beamThick / 2, beamPixelLen, beamThick, 3);
    ctx.fill();
    ctx.strokeStyle = COLORS.beamStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ======== Draw Supports at actual X coords ========
    supports.forEach((s, idx) => {
      const px = startX + (s.x / beamLength) * beamPixelLen;
      const isStart = idx === 0;
      const isEnd = idx === supports.length - 1;
      
      if (s.type === 'Fixed') {
        if (isStart) {
          drawFixedSupportEdge(ctx, px, beamY, false, 20);
        } else if (isEnd) {
          drawFixedSupportEdge(ctx, px, beamY, true, 20);
        } else {
          drawFixedSupportIntermediate(ctx, px, beamY + beamThick / 2, 20);
        }
      } else {
        // Pinned Support
        drawPinnedSupport(ctx, px, beamY + beamThick / 2, 20);
      }
    });

    // ======== Distributed Uniform Load (UDL) ========
    if (load !== 0) {
      const loadColor = COLORS.load;
      const numArrows = 16;
      const arrowLen = 30;
      const loadTop = beamY - beamThick / 2 - arrowLen - 8;

      // Draw continuous load line
      ctx.strokeStyle = loadColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(startX, loadTop);
      ctx.lineTo(endX, loadTop);
      ctx.stroke();

      // Load pressure arrows
      ctx.fillStyle = loadColor;
      ctx.strokeStyle = loadColor;
      ctx.lineWidth = 1.2;
      for (let i = 0; i <= numArrows; i++) {
        const t = i / numArrows;
        const ax = startX + t * beamPixelLen;
        drawArrow(ctx, ax, loadTop, ax, beamY - beamThick / 2 - 3, 6);
      }

      // Load label
      ctx.fillStyle = COLORS.loadArrow;
      ctx.font = `600 11px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`q = ${Math.abs(load).toFixed(1)} kN/m`, (startX + endX) / 2, loadTop - 7);
    }

    // ======== Point Loads (Siły skupione) ========
    pointLoads.forEach((pl, idx) => {
      if (pl.value === 0) return;
      const px = startX + (pl.x / beamLength) * beamPixelLen;
      const isDownward = pl.value < 0;
      const arrowColor = '#f97316'; // premium orange color
      
      ctx.strokeStyle = arrowColor;
      ctx.fillStyle = arrowColor;
      ctx.lineWidth = 2.5;

      const arrowHeight = 35;
      
      if (isDownward) {
        // Arrow pointing down, tip touching the top edge of the beam
        const arrowTop = beamY - beamThick / 2 - arrowHeight;
        const arrowBottom = beamY - beamThick / 2 - 3;
        drawArrow(ctx, px, arrowTop, px, arrowBottom, 8);
        
        // Text label above the arrow
        ctx.fillStyle = '#ffedd5'; // bright orange-tinted text
        ctx.font = `bold 10px 'JetBrains Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(`P${idx + 1} = ${Math.abs(pl.value).toFixed(1)} kN`, px, arrowTop - 5);
        ctx.fillStyle = COLORS.text;
        ctx.font = `500 8.5px 'JetBrains Mono', monospace`;
        ctx.fillText(`x = ${pl.x.toFixed(1)}m`, px, arrowTop - 15);
      } else {
        // Arrow pointing up, tip touching the bottom edge of the beam
        const arrowBottom = beamY + beamThick / 2 + arrowHeight;
        const arrowTop = beamY + beamThick / 2 + 3;
        drawArrow(ctx, px, arrowBottom, px, arrowTop, 8);
        
        // Text label below the arrow
        ctx.fillStyle = '#ffedd5';
        ctx.font = `bold 10px 'JetBrains Mono', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(`P${idx + 1} = ${Math.abs(pl.value).toFixed(1)} kN`, px, arrowBottom + 12);
        ctx.fillStyle = COLORS.text;
        ctx.font = `500 8.5px 'JetBrains Mono', monospace`;
        ctx.fillText(`x = ${pl.x.toFixed(1)}m`, px, arrowBottom + 21);
      }
    });

    // ======== Continuous Dimension Line ========
    const dimY = beamY + 60;
    ctx.strokeStyle = COLORS.dimLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, dimY);
    ctx.lineTo(endX, dimY);
    ctx.stroke();
    
    // Outer ticks
    ctx.beginPath();
    ctx.moveTo(startX, dimY - 4); ctx.lineTo(startX, dimY + 4);
    ctx.moveTo(endX, dimY - 4); ctx.lineTo(endX, dimY + 4);
    ctx.stroke();
    
    // Support ticks
    supports.forEach((s) => {
      const px = startX + (s.x / beamLength) * beamPixelLen;
      ctx.beginPath();
      ctx.moveTo(px, dimY - 3);
      ctx.lineTo(px, dimY + 3);
      ctx.stroke();
    });

    // Length label
    ctx.fillStyle = COLORS.text;
    ctx.font = `500 11px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`L = ${beamLength.toFixed(1)} m`, (startX + endX) / 2, dimY + 16);

    // ======== Node Labels ========
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 11px 'Inter', sans-serif`;
    ctx.textAlign = 'center';
    supports.forEach((s, idx) => {
      const px = startX + (s.x / beamLength) * beamPixelLen;
      ctx.fillText(`N${idx + 1}`, px, beamY + 45);
    });

    // ======== Results Diagrams ========
    if (results && results.length > 0) {
      // 1. Bending Moment (M)
      const momentBaseY = beamY + 140;
      const maxMoment = Math.max(...results.map(r => Math.abs(r.moment)));
      const momentScale = maxMoment > 0 ? 45 / maxMoment : 1;
      drawMeshDiagram(
        ctx, results, 'moment',
        startX, momentBaseY, beamLength, beamPixelLen,
        momentScale,
        COLORS.moment, COLORS.momentFill,
        'M [kNm] (włókna rozciągane)',
        true, // invertSign = true so positive moment is drawn below axis
      );

      // 2. Shear Force (V)
      const shearBaseY = beamY + 265;
      const maxShear = Math.max(...results.map(r => Math.abs(r.shear)));
      const shearScale = maxShear > 0 ? 35 / maxShear : 1;
      drawMeshDiagram(
        ctx, results, 'shear',
        startX, shearBaseY, beamLength, beamPixelLen,
        shearScale,
        COLORS.shear, COLORS.shearFill,
        'V [kN]',
        false,
      );

      // 3. Deflection (δ)
      const deflBaseY = beamY + 380;
      const maxDefl = Math.max(...results.map(r => Math.abs(r.deflection)));
      const deflScale = maxDefl > 0 ? 30 / maxDefl : 1;
      drawMeshDiagram(
        ctx, results, 'deflection',
        startX, deflBaseY, beamLength, beamPixelLen,
        deflScale,
        COLORS.deflection, COLORS.deflectionFill,
        'δ [mm]',
        false,
      );
    }

    // ======== Draw Active Sketch Stroke (Faza 4) ========
    if (currentStroke.length > 1) {
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.75)'; // premium semi-transparent neon blue
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = '#3b82f6';
      ctx.shadowBlur = 8;

      ctx.beginPath();
      ctx.moveTo(currentStroke[0].x, currentStroke[0].y);
      for (let i = 1; i < currentStroke.length; i++) {
        ctx.lineTo(currentStroke[i].x, currentStroke[i].y);
      }
      ctx.stroke();

      // Reset shadow
      ctx.shadowBlur = 0;
    }
  }, [results, supports, pointLoads, beamLength, load, activeTool, currentStroke]);

  useEffect(() => {
    draw();

    const handleResize = () => draw();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        style={{ 
          position: 'absolute', 
          inset: 0, 
          cursor: activeTool === 'draw_beam' ? 'crosshair' : 'default',
          touchAction: activeTool === 'draw_beam' ? 'none' : 'auto'
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
      
      {/* Visual Toast Notification Overlay (Faza 4) */}
      {toastMessage && (
        <div style={{
          position: 'absolute',
          top: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(30, 41, 59, 0.75)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(59, 130, 246, 0.3)',
          boxShadow: '0 4px 20px rgba(59, 130, 246, 0.15), 0 0 15px rgba(59, 130, 246, 0.1)',
          padding: '10px 20px',
          borderRadius: '12px',
          color: '#e2e8f0',
          fontSize: '13px',
          fontWeight: '600',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          zIndex: 100,
          pointerEvents: 'none',
          animation: 'fadeInOut 2.5s ease-in-out forwards',
        }}>
          {toastMessage}
        </div>
      )}

      {/* Embedded CSS for Toast fade animation */}
      <style>{`
        @keyframes fadeInOut {
          0% { opacity: 0; transform: translate(-50%, -10px); }
          10% { opacity: 1; transform: translate(-50%, 0); }
          90% { opacity: 1; transform: translate(-50%, 0); }
          100% { opacity: 0; transform: translate(-50%, -10px); }
        }
      `}</style>
    </div>
  );
}
