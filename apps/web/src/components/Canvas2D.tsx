import { useRef, useEffect, useCallback } from 'react';

// =============================================================================
// Types matching the Rust solver output
// =============================================================================

export interface BeamResults {
  element_id: string;
  length: number;
  reaction_left: number;
  reaction_right: number;
  max_moment: number;
  max_moment_position: number;
  max_shear: number;
  max_deflection: number;
  moment_diagram: number[];
  shear_diagram: number[];
  deflection_diagram: number[];
}

interface Canvas2DProps {
  results: BeamResults | null;
  beamLength: number;
  load: number;
}

// =============================================================================
// Canvas Drawing Engine
// =============================================================================

// Color palette
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
  grid: 'rgba(148, 163, 184, 0.06)',
  gridMajor: 'rgba(148, 163, 184, 0.12)',
  axis: 'rgba(148, 163, 184, 0.25)',
  text: '#94a3b8',
  textBright: '#e2e8f0',
  dimLine: 'rgba(148, 163, 184, 0.3)',
  reaction: '#10b981',
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

  // Hatch lines under support
  ctx.strokeStyle = COLORS.support;
  ctx.lineWidth = 1;
  const baseY = y + size;
  ctx.beginPath();
  ctx.moveTo(x - size * 0.8, baseY + 4);
  ctx.lineTo(x + size * 0.8, baseY + 4);
  ctx.stroke();
  for (let i = -3; i <= 3; i++) {
    const hx = x + i * (size * 0.2);
    ctx.beginPath();
    ctx.moveTo(hx, baseY + 4);
    ctx.lineTo(hx - 5, baseY + 10);
    ctx.stroke();
  }
}

function drawRollerSupport(ctx: CanvasRenderingContext2D, x: number, y: number, size: number = 20) {
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

  // Roller circle
  const circleY = y + size + 7;
  ctx.beginPath();
  ctx.arc(x, circleY, 5, 0, Math.PI * 2);
  ctx.stroke();

  // Ground line
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - size * 0.8, circleY + 7);
  ctx.lineTo(x + size * 0.8, circleY + 7);
  ctx.stroke();
}

function drawDiagram(
  ctx: CanvasRenderingContext2D,
  values: number[],
  startX: number, baseY: number, beamPixelLen: number,
  scale: number,
  color: string, fillColor: string,
  label: string,
) {
  const numStations = values.length;

  // Fill
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.moveTo(startX, baseY);
  for (let i = 0; i < numStations; i++) {
    const t = i / (numStations - 1);
    const px = startX + t * beamPixelLen;
    const py = baseY - values[i] * scale;
    if (i === 0) ctx.lineTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.lineTo(startX + beamPixelLen, baseY);
  ctx.closePath();
  ctx.fill();

  // Stroke
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < numStations; i++) {
    const t = i / (numStations - 1);
    const px = startX + t * beamPixelLen;
    const py = baseY - values[i] * scale;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Baseline
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(startX, baseY);
  ctx.lineTo(startX + beamPixelLen, baseY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Max value label
  const maxVal = Math.max(...values.map(Math.abs));
  const maxIdx = values.findIndex(v => Math.abs(v) === maxVal);
  if (maxIdx >= 0) {
    const t = maxIdx / (numStations - 1);
    const px = startX + t * beamPixelLen;
    const py = baseY - values[maxIdx] * scale;

    ctx.fillStyle = color;
    ctx.font = `600 12px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'center';
    const sign = values[maxIdx] >= 0 ? '' : '-';
    ctx.fillText(`${sign}${maxVal.toFixed(2)}`, px, py - 8);
  }

  // Label
  ctx.fillStyle = color;
  ctx.font = `700 13px 'Inter', sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(label, startX - 5, baseY - 55);
}

// =============================================================================
// Canvas2D Component
// =============================================================================

export default function Canvas2D({ results, beamLength, load }: Canvas2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    // Draw grid
    drawGrid(ctx, w, h);

    // Layout
    const margin = { left: 80, right: 80, top: 60, bottom: 60 };
    const beamY = margin.top + 80;
    const beamPixelLen = w - margin.left - margin.right;
    const startX = margin.left;
    const endX = startX + beamPixelLen;

    // ======== Draw Beam ========
    ctx.strokeStyle = COLORS.beamStroke;
    ctx.fillStyle = COLORS.beam;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    // Beam shadow
    ctx.shadowColor = 'rgba(59, 130, 246, 0.15)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(startX, beamY);
    ctx.lineTo(endX, beamY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Beam rectangle (thick)
    const beamThick = 8;
    ctx.fillStyle = COLORS.beam;
    ctx.beginPath();
    ctx.roundRect(startX, beamY - beamThick / 2, beamPixelLen, beamThick, 3);
    ctx.fill();
    ctx.strokeStyle = COLORS.beamStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // ======== Supports ========
    drawPinnedSupport(ctx, startX, beamY + beamThick / 2);
    drawRollerSupport(ctx, endX, beamY + beamThick / 2);

    // ======== Distributed Load ========
    if (load !== 0) {
      const loadColor = COLORS.load;
      const numArrows = 12;
      const arrowLen = 35;
      const loadTop = beamY - beamThick / 2 - arrowLen - 10;

      // Top line
      ctx.strokeStyle = loadColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, loadTop);
      ctx.lineTo(endX, loadTop);
      ctx.stroke();

      // Arrows
      ctx.fillStyle = loadColor;
      ctx.strokeStyle = loadColor;
      ctx.lineWidth = 1.5;
      for (let i = 0; i <= numArrows; i++) {
        const t = i / numArrows;
        const ax = startX + t * beamPixelLen;
        drawArrow(ctx, ax, loadTop, ax, beamY - beamThick / 2 - 4, 7);
      }

      // Load value
      ctx.fillStyle = COLORS.loadArrow;
      ctx.font = `600 12px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`q = ${Math.abs(load).toFixed(1)} kN/m`, (startX + endX) / 2, loadTop - 8);
    }

    // ======== Dimension Line ========
    const dimY = beamY + 70;
    ctx.strokeStyle = COLORS.dimLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, dimY);
    ctx.lineTo(endX, dimY);
    ctx.stroke();
    // Ticks
    ctx.beginPath();
    ctx.moveTo(startX, dimY - 4);
    ctx.lineTo(startX, dimY + 4);
    ctx.moveTo(endX, dimY - 4);
    ctx.lineTo(endX, dimY + 4);
    ctx.stroke();
    // Length label
    ctx.fillStyle = COLORS.text;
    ctx.font = `500 12px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`L = ${beamLength.toFixed(1)} m`, (startX + endX) / 2, dimY + 18);

    // ======== Node Labels ========
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 11px 'Inter', sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('N1', startX, beamY + 60);
    ctx.fillText('N2', endX, beamY + 60);

    // ======== Results Diagrams ========
    if (results) {
      // Reaction arrows
      ctx.fillStyle = COLORS.reaction;
      ctx.strokeStyle = COLORS.reaction;
      ctx.lineWidth = 2;
      const reactionScale = 1.5;

      // Left reaction (upward arrow)
      const rLeftLen = results.reaction_left * reactionScale;
      drawArrow(ctx, startX, beamY + 55, startX, beamY + 55 - rLeftLen, 9);
      ctx.font = `600 11px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`R₁ = ${results.reaction_left.toFixed(2)} kN`, startX, beamY + 68);

      // Right reaction
      const rRightLen = results.reaction_right * reactionScale;
      drawArrow(ctx, endX, beamY + 55, endX, beamY + 55 - rRightLen, 9);
      ctx.fillText(`R₂ = ${results.reaction_right.toFixed(2)} kN`, endX, beamY + 68);

      // Moment diagram
      const momentBaseY = beamY + 150;
      const maxMoment = Math.max(...results.moment_diagram.map(Math.abs));
      const momentScale = maxMoment > 0 ? 50 / maxMoment : 1;
      drawDiagram(
        ctx, results.moment_diagram,
        startX, momentBaseY, beamPixelLen,
        momentScale,
        COLORS.moment, COLORS.momentFill,
        'M [kNm]',
      );

      // Shear diagram
      const shearBaseY = beamY + 280;
      const maxShear = Math.max(...results.shear_diagram.map(Math.abs));
      const shearScale = maxShear > 0 ? 40 / maxShear : 1;
      drawDiagram(
        ctx, results.shear_diagram,
        startX, shearBaseY, beamPixelLen,
        shearScale,
        COLORS.shear, COLORS.shearFill,
        'V [kN]',
      );

      // Deflection diagram (inverted — deflection downward)
      const deflBaseY = beamY + 400;
      const maxDefl = Math.max(...results.deflection_diagram.map(Math.abs));
      const deflScale = maxDefl > 0 ? -35 / maxDefl : 1; // negative = draw downward
      drawDiagram(
        ctx, results.deflection_diagram,
        startX, deflBaseY, beamPixelLen,
        deflScale,
        COLORS.deflection, COLORS.deflectionFill,
        'δ [mm]',
      );
    }
  }, [results, beamLength, load]);

  useEffect(() => {
    draw();

    const handleResize = () => draw();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  return <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0 }} />;
}
