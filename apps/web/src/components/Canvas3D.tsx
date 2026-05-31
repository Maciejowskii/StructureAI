import { useRef, useEffect, useState } from 'react';

interface Canvas3DProps {
  model: any | null;
  result: any | null;
  deformationScale: number;
  activeTool?: string;
  selectedEntity?: { type: 'node' | 'element', id: string } | null;
  onSelectEntity?: (entity: { type: 'node' | 'element', id: string } | null) => void;
  onAddElement3D?: (startNodeId: string, endNodeId: string) => void;
}

export default function Canvas3D({
  model,
  result,
  deformationScale,
  activeTool = 'select',
  selectedEntity = null,
  onSelectEntity,
  onAddElement3D
}: Canvas3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [angleX, setAngleX] = useState(-0.6); // Rotation around Y
  const [angleY, setAngleY] = useState(0.3);  // Rotation around X
  const [zoom, setZoom] = useState(1.1);
  const [pulseTime, setPulseTime] = useState(0);

  // Selection states synced to parent
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Drag rod drawing states
  const [dragStartNodeId, setDragStartNodeId] = useState<string | null>(null);
  const [dragCurrentPos, setDragCurrentPos] = useState<{ x: number, y: number } | null>(null);

  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;

  const onSelectEntityRef = useRef(onSelectEntity);
  onSelectEntityRef.current = onSelectEntity;

  const onAddElement3DRef = useRef(onAddElement3D);
  onAddElement3DRef.current = onAddElement3D;

  const projectedNodesRef = useRef<{ id: string, x: number, y: number }[]>([]);
  const projectedElementsRef = useRef<{ id: string, x1: number, y1: number, x2: number, y2: number }[]>([]);

  // Sync selection with prop
  useEffect(() => {
    if (selectedEntity) {
      if (selectedEntity.type === 'node') {
        setSelectedNodeId(selectedEntity.id);
        setSelectedElementId(null);
      } else if (selectedEntity.type === 'element') {
        setSelectedElementId(selectedEntity.id);
        setSelectedNodeId(null);
      }
    } else {
      setSelectedNodeId(null);
      setSelectedElementId(null);
    }
  }, [selectedEntity]);

  // Engineering stress color mapping function
  const getColorForUtilization = (val: number): string => {
    if (val <= 0.2) return '#3b82f6'; // Bright blue
    if (val <= 0.5) return '#10b981'; // Emerald green
    if (val <= 0.8) return '#eab308'; // Solar yellow
    if (val <= 1.0) return '#f97316'; // Orange
    return '#ef4444'; // Red (SGN exceeded)
  };

  // Pulsing tick
  useEffect(() => {
    let animFrameId: number;
    const updatePulse = () => {
      setPulseTime(Date.now());
      animFrameId = requestAnimationFrame(updatePulse);
    };
    animFrameId = requestAnimationFrame(updatePulse);
    return () => cancelAnimationFrame(animFrameId);
  }, []);

  // Raycasting distance helper (point to segment)
  const distToSegment = (p: { x: number, y: number }, v: { x: number, y: number }, w: { x: number, y: number }): number => {
    const l2 = Math.hypot(v.x - w.x, v.y - w.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
  };

  // Click Hit Testing (Raycasting)
  const performHitTest = (xm: number, ym: number) => {
    // 1. Sprawdzamy węzły (Node Hit Testing - 15px radius)
    let nearestNode: { id: string, dist: number } | null = null;
    projectedNodesRef.current.forEach(n => {
      const dist = Math.hypot(xm - n.x, ym - n.y);
      if (dist < 15) {
        if (!nearestNode || dist < nearestNode.dist) {
          nearestNode = { id: n.id, dist };
        }
      }
    });

    if (nearestNode) {
      return { type: 'node' as const, id: (nearestNode as any).id };
    }

    // 2. Sprawdzamy pręty (Element Hit Testing - 10px line distance)
    let nearestElement: { id: string, dist: number } | null = null;
    projectedElementsRef.current.forEach(el => {
      const p1 = { x: el.x1, y: el.y1 };
      const p2 = { x: el.x2, y: el.y2 };
      const dist = distToSegment({ x: xm, y: ym }, p1, p2);
      if (dist < 10) {
        if (!nearestElement || dist < nearestElement.dist) {
          nearestElement = { id: el.id, dist };
        }
      }
    });

    if (nearestElement) {
      return { type: 'element' as const, id: (nearestElement as any).id };
    }

    return null;
  };

  // Event handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isDraggingCamera = false;
    let startX = 0;
    let startY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const xm = e.clientX - rect.left;
      const ym = e.clientY - rect.top;

      if (activeToolRef.current === 'draw_beam') {
        const hit = performHitTest(xm, ym);
        if (hit && hit.type === 'node') {
          setDragStartNodeId(hit.id);
          setDragCurrentPos({ x: xm, y: ym });
        }
      } else if (activeToolRef.current === 'select') {
        const hit = performHitTest(xm, ym);
        if (hit) {
          if (onSelectEntityRef.current) {
            onSelectEntityRef.current({ type: hit.type, id: hit.id });
          }
        } else {
          if (onSelectEntityRef.current) {
            onSelectEntityRef.current(null);
          }
          isDraggingCamera = true;
          startX = e.clientX;
          startY = e.clientY;
        }
      } else {
        isDraggingCamera = true;
        startX = e.clientX;
        startY = e.clientY;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const xm = e.clientX - rect.left;
      const ym = e.clientY - rect.top;

      if (dragStartNodeId) {
        setDragCurrentPos({ x: xm, y: ym });
        return;
      }

      if (!isDraggingCamera) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;

      setAngleX(prev => prev + dx * 0.007);
      setAngleY(prev => Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, prev - dy * 0.007)));
    };

    const handleMouseUp = (e: MouseEvent) => {
      isDraggingCamera = false;

      if (dragStartNodeId) {
        const rect = canvas.getBoundingClientRect();
        const xm = e.clientX - rect.left;
        const ym = e.clientY - rect.top;

        const hit = performHitTest(xm, ym);
        if (hit && hit.type === 'node' && hit.id !== dragStartNodeId) {
          if (onAddElement3DRef.current) {
            onAddElement3DRef.current(dragStartNodeId, hit.id);
          }
        }
        setDragStartNodeId(null);
        setDragCurrentPos(null);
      }
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(prev => Math.max(0.3, Math.min(4.0, prev - e.deltaY * 0.001)));
    };

    // Touch support for mobiles
    let touchStartX = 0;
    let touchStartY = 0;
    let isTouchDrawing = false;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const rect = canvas.getBoundingClientRect();
        const xm = e.touches[0].clientX - rect.left;
        const ym = e.touches[0].clientY - rect.top;

        if (activeToolRef.current === 'draw_beam') {
          const hit = performHitTest(xm, ym);
          if (hit && hit.type === 'node') {
            setDragStartNodeId(hit.id);
            setDragCurrentPos({ x: xm, y: ym });
            isTouchDrawing = true;
          }
        } else if (activeToolRef.current === 'select') {
          const hit = performHitTest(xm, ym);
          if (hit) {
            if (onSelectEntityRef.current) {
              onSelectEntityRef.current({ type: hit.type, id: hit.id });
            }
          } else {
            if (onSelectEntityRef.current) {
              onSelectEntityRef.current(null);
            }
            isDraggingCamera = true;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
          }
        } else {
          isDraggingCamera = true;
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const rect = canvas.getBoundingClientRect();
      const xm = e.touches[0].clientX - rect.left;
      const ym = e.touches[0].clientY - rect.top;

      if (isTouchDrawing && dragStartNodeId) {
        setDragCurrentPos({ x: xm, y: ym });
        return;
      }

      if (!isDraggingCamera) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;

      setAngleX(prev => prev + dx * 0.007);
      setAngleY(prev => Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, prev - dy * 0.007)));
    };

    const handleTouchEnd = (_e: TouchEvent) => {
      isDraggingCamera = false;

      if (isTouchDrawing && dragStartNodeId) {
        if (dragCurrentPos) {
          const hit = performHitTest(dragCurrentPos.x, dragCurrentPos.y);
          if (hit && hit.type === 'node' && hit.id !== dragStartNodeId) {
            if (onAddElement3DRef.current) {
              onAddElement3DRef.current(dragStartNodeId, hit.id);
            }
          }
        }
        setDragStartNodeId(null);
        setDragCurrentPos(null);
        isTouchDrawing = false;
      }
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel, { passive: false });

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
  }, [dragStartNodeId, dragCurrentPos]);

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
      const x1 = x * Math.cos(angleX) - z * Math.sin(angleX);
      const z1 = x * Math.sin(angleX) + z * Math.cos(angleX);
      const y2 = y * Math.cos(angleY) - z1 * Math.sin(angleY);
      const z2 = y * Math.sin(angleY) + z1 * Math.cos(angleY);

      const distance = 400;
      const scale = 220 * zoom;

      const xs = w / 2 + (x1 * scale) / (z2 + distance);
      const ys = h / 2 - (y2 * scale) / (z2 + distance);

      return { x: xs, y: ys, zDepth: z2 };
    };

    const nodes: any[] = model?.geometry?.nodes || model?.nodes || [];
    const elements: any[] = model?.geometry?.elements || model?.elements || [];

    // Center layout calculations
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

    // 1. Draw Grid
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

    // 3. Process and render elements with Depth Cueing
    if (nodes.length > 0) {
      // Refresh projected coords for raycasting
      const projectedNodes: { id: string, x: number, y: number }[] = [];
      nodes.forEach(n => {
        const px = project((n.x - midX) * scaleFactor, (n.y - midY) * scaleFactor, (n.z - midZ) * scaleFactor);
        projectedNodes.push({ id: n.id, x: px.x, y: px.y });
      });
      projectedNodesRef.current = projectedNodes;

      const projectedElements: { id: string, x1: number, y1: number, x2: number, y2: number }[] = [];

      const elementsWithDepth = elements.map(el => {
        const n1 = nodes.find(n => n.id === el.startNode);
        const n2 = nodes.find(n => n.id === el.endNode);
        if (!n1 || !n2) return null;

        const p1 = project((n1.x - midX) * scaleFactor, (n1.y - midY) * scaleFactor, (n1.z - midZ) * scaleFactor);
        const p2 = project((n2.x - midX) * scaleFactor, (n2.y - midY) * scaleFactor, (n2.z - midZ) * scaleFactor);

        projectedElements.push({ id: el.id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });

        // Apply deformation deflection displacement if results exist
        let dp1 = p1;
        let dp2 = p2;
        if (result && result.displacements) {
          const resN1 = result.displacements[n1.id];
          const resN2 = result.displacements[n2.id];
          if (resN1 && resN2) {
            const exag = 100.0 * (deformationScale / 100.0);
            dp1 = project(
              (n1.x + (resN1[0] / 1000.0) * exag - midX) * scaleFactor,
              (n1.y + (resN1[1] / 1000.0) * exag - midY) * scaleFactor,
              (n1.z + (resN1[2] / 1000.0) * exag - midZ) * scaleFactor
            );
            dp2 = project(
              (n2.x + (resN2[0] / 1000.0) * exag - midX) * scaleFactor,
              (n2.y + (resN2[1] / 1000.0) * exag - midY) * scaleFactor,
              (n2.z + (resN2[2] / 1000.0) * exag - midZ) * scaleFactor
            );
          }
        }

        const avgDepth = (p1.zDepth + p2.zDepth) / 2;
        return { el, p1, p2, dp1, dp2, avgDepth, n1, n2 };
      }).filter(x => x !== null) as any[];

      projectedElementsRef.current = projectedElements;

      // painter's algorithm
      elementsWithDepth.sort((a, b) => b.avgDepth - a.avgDepth);

      // Render elements
      elementsWithDepth.forEach(({ el, p1, p2, dp1, dp2, avgDepth }) => {
        const maxDist = 300;
        const normDepth = Math.max(0, Math.min(1, (avgDepth + maxDist / 2) / maxDist));
        const brightness = Math.max(0.25, Math.min(1.0, 1.1 - normDepth));

        const isBrace = el.groupId === 'bracings';
        const isPurlin = el.id.includes('Purlin') || el.id.includes('Girt');

        // Draw structural member (undeformed element as dotted background line)
        ctx.strokeStyle = 'rgba(51, 65, 85, ' + (brightness * 0.3) + ')';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.setLineDash([]); // Reset

        // Fetch utilization array from Rust solver result
        const uArray = result?.utilization?.[el.id] || [0.0, 0.0, 0.0, 0.0, 0.0];

        let strokeStyle: string | CanvasGradient;
        let shadowColor = '#3b82f6';
        let blurSize = 6;

        const maxU = Math.max(...uArray);
        if (maxU <= 0.2) shadowColor = '#3b82f6';
        else if (maxU <= 0.5) shadowColor = '#10b981';
        else if (maxU <= 0.8) shadowColor = '#eab308';
        else if (maxU <= 1.0) shadowColor = '#f97316';
        else {
          shadowColor = '#ef4444';
          blurSize = 10 * (0.8 + 0.4 * Math.sin(pulseTime * 0.008));
        }

        // Create linear gradient
        const grad = ctx.createLinearGradient(dp1.x, dp1.y, dp2.x, dp2.y);
        grad.addColorStop(0.0, getColorForUtilization(uArray[0]));
        grad.addColorStop(0.25, getColorForUtilization(uArray[1]));
        grad.addColorStop(0.50, getColorForUtilization(uArray[2]));
        grad.addColorStop(0.75, getColorForUtilization(uArray[3]));
        grad.addColorStop(1.0, getColorForUtilization(uArray[4]));
        strokeStyle = grad;

        // Draw deformed structure member (main glowing view)
        const isSelectedEl = selectedElementId === el.id;
        if (isSelectedEl) {
          ctx.shadowColor = '#ffffff';
          ctx.shadowBlur = 18;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = isBrace ? 5 : isPurlin ? 5.5 : 7.5;
        } else {
          ctx.shadowColor = shadowColor;
          ctx.shadowBlur = result ? blurSize * brightness : 0;
          ctx.strokeStyle = strokeStyle;
          ctx.lineWidth = isBrace ? 3 : isPurlin ? 3.5 : 5;
        }

        ctx.beginPath();
        ctx.moveTo(dp1.x, dp1.y);
        ctx.lineTo(dp2.x, dp2.y);
        ctx.stroke();

        ctx.shadowBlur = 0; // Reset glow
      });

      // 4. Draw Nodal support markers
      nodes.forEach(n => {
        const px = project((n.x - midX) * scaleFactor, (n.y - midY) * scaleFactor, (n.z - midZ) * scaleFactor);
        const isSelected = selectedNodeId === n.id;
        const restraints = n.supportRestraints || [];

        ctx.shadowBlur = 0;

        const isFixed = restraints[0] && restraints[1] && restraints[2] && restraints[3] && restraints[4] && restraints[5];
        const isPinned = restraints[0] && restraints[1] && restraints[2] && !restraints[3] && !restraints[4] && !restraints[5];
        const hasAnySupport = restraints.some((r: boolean) => r);

        if (isFixed) {
          // Fixed support (Red block)
          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.arc(px.x, px.y, 5, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(px.x - 8, px.y + 4);
          ctx.lineTo(px.x + 8, px.y + 4);
          ctx.stroke();
        } else if (isPinned) {
          // Pinned support (Blue triangle)
          ctx.fillStyle = '#3b82f6';
          ctx.beginPath();
          ctx.arc(px.x, px.y, 5, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(px.x - 6, px.y + 5);
          ctx.lineTo(px.x + 6, px.y + 5);
          ctx.lineTo(px.x, px.y);
          ctx.closePath();
          ctx.stroke();
        } else if (hasAnySupport) {
          // Custom supports (Orange dot)
          ctx.fillStyle = '#f97316';
          ctx.beginPath();
          ctx.arc(px.x, px.y, 5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Free node (Purple dot)
          ctx.fillStyle = '#a855f7';
          ctx.beginPath();
          ctx.arc(px.x, px.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }

        // Selected node indicator ring (pulsing)
        if (isSelected) {
          const radius = 10 + 4 * Math.sin(pulseTime * 0.008);
          ctx.strokeStyle = '#ffffff';
          ctx.shadowColor = '#ffffff';
          ctx.shadowBlur = 15;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(px.x, px.y, radius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.shadowBlur = 0; // Reset
        }
      });

      // 5. Draw active dragging preview line for draw_beam tool
      if (dragStartNodeId && dragCurrentPos) {
        const startNode = nodes.find(n => n.id === dragStartNodeId);
        if (startNode) {
          const sp = project((startNode.x - midX) * scaleFactor, (startNode.y - midY) * scaleFactor, (startNode.z - midZ) * scaleFactor);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.lineWidth = 3;
          ctx.setLineDash([5, 5]);
          ctx.shadowColor = '#ffffff';
          ctx.shadowBlur = 8;

          ctx.beginPath();
          ctx.moveTo(sp.x, sp.y);
          ctx.lineTo(dragCurrentPos.x, dragCurrentPos.y);
          ctx.stroke();

          ctx.setLineDash([]);
          ctx.shadowBlur = 0;
        }
      }
    }

  }, [model, result, angleX, angleY, zoom, deformationScale, pulseTime, selectedElementId, selectedNodeId, dragStartNodeId, dragCurrentPos]);

  const maxDisp = result && result.displacements
    ? Math.max(...Object.values(result.displacements).map((disp: any) => Math.hypot(disp[0], disp[1], disp[2])))
    : 0.0;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas 
        ref={canvasRef} 
        style={{ display: 'block', width: '100%', height: '100%', cursor: activeTool === 'select' ? 'pointer' : 'grab' }}
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
          Interaktywna przestrzeń CAD/CAE. Kliknij pręt lub węzeł, aby go edytować, lub rysuj nowe połączenia.
        </div>
        
        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Liczba węzłów:</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>{model?.geometry?.nodes?.length || model?.nodes?.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Pręty ramy:</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>{model?.geometry?.elements?.length || model?.elements?.length}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>Maks. ugięcie:</span>
              <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>{maxDisp.toFixed(1)} mm</span>
            </div>
          </div>
        )}
      </div>

      {/* Elegant Glassmorphism Stress Heatmap Legend Box */}
      <div style={{
        position: 'absolute',
        top: '220px',
        left: '20px',
        background: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(139, 92, 246, 0.25)',
        padding: '16px',
        borderRadius: '12px',
        boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.5)',
        width: '260px',
        color: '#f8fafc',
        pointerEvents: 'none'
      }}>
        <div style={{ fontWeight: 'bold', fontSize: '11px', color: '#c4b5fd', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span>📊</span> Heatmapa Wytężenia SGN (EC3)
        </div>
        
        <div style={{ display: 'flex', alignItems: 'stretch', gap: '16px' }}>
          <div style={{
            width: '14px',
            height: '150px',
            borderRadius: '6px',
            background: 'linear-gradient(to top, #3b82f6 0%, #10b981 25%, #eab308 65%, #ef4444 100%)',
            boxShadow: '0 0 10px rgba(139, 92, 246, 0.2)',
            position: 'relative'
          }} />

          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: '10.5px', height: '150px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
              <span style={{ color: '#ef4444', fontWeight: 'bold' }}>&ge; 1.0 (Limit nośności SGN)</span>
              <span style={{ color: '#64748b', fontSize: '9px' }}>Przeciążenie, ryzyko katastrofy</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <span style={{ color: '#f97316', fontWeight: '600' }}>0.8 - 1.0 (Wysokie)</span>
              <span style={{ color: '#64748b', fontSize: '9px' }}>Blisko granicy bezpieczeństwa</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <span style={{ color: '#eab308', fontWeight: '600' }}>0.5 - 0.8 (Optymalne)</span>
              <span style={{ color: '#64748b', fontSize: '9px' }}>Efektywność materiałowa</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <span style={{ color: '#10b981', fontWeight: '600' }}>0.2 - 0.5 (Bezpieczne)</span>
              <span style={{ color: '#64748b', fontSize: '9px' }}>Duży zapas nośności</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <span style={{ color: '#3b82f6', fontWeight: '600' }}>0.0 - 0.2 (Niskie)</span>
              <span style={{ color: '#64748b', fontSize: '9px' }}>Brak obciążenia / niski napręż</span>
            </div>
          </div>
        </div>
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
        {activeTool === 'select' 
          ? '🖱 Kliknij obiekt, aby wybrać | Lewy przycisk + ruch w puste tło: Obrót' 
          : '✏ Kliknij węzeł A i przeciągnij do węzła B, aby dodać pręt'}
      </div>
    </div>
  );
}
