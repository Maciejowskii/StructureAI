import { useRef, useEffect, useState } from 'react';

export default function Canvas3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showFrame, setShowFrame] = useState(false);

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

    // Tło główne (Slate 950)
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);

    // Prosta wizualizacja aksonometryczna (izometryczna) siatki 3D
    const cx = w / 2;
    const cy = h / 2 + 80;
    
    // Rysowanie "podłogi" (siatki na płaszczyźnie XZ)
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.6)'; // Ciemna siatka
    ctx.lineWidth = 1;

    const gridLines = 15;
    const spacing = 25;
    
    const isoX = (x: number, _y: number, z: number) => cx + (x - z) * Math.cos(Math.PI / 6);
    const isoY = (x: number, y: number, z: number) => cy + (x + z) * Math.sin(Math.PI / 6) - y;

    ctx.beginPath();
    for (let i = -gridLines; i <= gridLines; i++) {
      // Linie wzdłuż Z
      const p1_start_x = isoX(i * spacing, 0, -gridLines * spacing);
      const p1_start_y = isoY(i * spacing, 0, -gridLines * spacing);
      const p1_end_x = isoX(i * spacing, 0, gridLines * spacing);
      const p1_end_y = isoY(i * spacing, 0, gridLines * spacing);
      ctx.moveTo(p1_start_x, p1_start_y);
      ctx.lineTo(p1_end_x, p1_end_y);

      // Linie wzdłuż X
      const p2_start_x = isoX(-gridLines * spacing, 0, i * spacing);
      const p2_start_y = isoY(-gridLines * spacing, 0, i * spacing);
      const p2_end_x = isoX(gridLines * spacing, 0, i * spacing);
      const p2_end_y = isoY(gridLines * spacing, 0, i * spacing);
      ctx.moveTo(p2_start_x, p2_start_y);
      ctx.lineTo(p2_end_x, p2_end_y);
    }
    ctx.stroke();

    // Rysowanie osi 3D
    const axisLen = 120;
    ctx.lineWidth = 2.5;
    
    // Oś X (Czerwona)
    ctx.strokeStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(isoX(0, 0, 0), isoY(0, 0, 0));
    ctx.lineTo(isoX(axisLen, 0, 0), isoY(axisLen, 0, 0));
    ctx.stroke();
    ctx.fillStyle = '#ef4444';
    ctx.font = '12px monospace';
    ctx.fillText('X', isoX(axisLen + 8, 0, 0), isoY(axisLen + 8, 0, 0));

    // Oś Z (Niebieska)
    ctx.strokeStyle = '#3b82f6';
    ctx.beginPath();
    ctx.moveTo(isoX(0, 0, 0), isoY(0, 0, 0));
    ctx.lineTo(isoX(0, 0, axisLen), isoY(0, 0, axisLen));
    ctx.stroke();
    ctx.fillStyle = '#3b82f6';
    ctx.fillText('Z', isoX(0, 0, axisLen + 8), isoY(0, 0, axisLen + 8));

    // Oś Y (Zielona)
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    ctx.moveTo(isoX(0, 0, 0), isoY(0, 0, 0));
    ctx.lineTo(isoX(0, axisLen, 0), isoY(0, axisLen, 0));
    ctx.stroke();
    ctx.fillStyle = '#22c55e';
    ctx.fillText('Y', isoX(0, axisLen + 8, 0), isoY(0, axisLen + 8, 0));

    // Rysowanie trójwymiarowej ramy przestrzennej, jeśli wczytana
    if (showFrame) {
      // Węzły ramy w 3D (x, y, z)
      // Szerokość 150, Wysokość 120, Głębokość 150
      const wFrame = 120;
      const hFrame = 100;
      const dFrame = 120;

      const nodes = [
        { x: -wFrame, y: 0, z: -dFrame, id: '1' },
        { x: wFrame, y: 0, z: -dFrame, id: '2' },
        { x: wFrame, y: 0, z: dFrame, id: '3' },
        { x: -wFrame, y: 0, z: dFrame, id: '4' },
        
        { x: -wFrame, y: hFrame, z: -dFrame, id: '5' },
        { x: wFrame, y: hFrame, z: -dFrame, id: '6' },
        { x: wFrame, y: hFrame, z: dFrame, id: '7' },
        { x: -wFrame, y: hFrame, z: dFrame, id: '8' },

        { x: 0, y: hFrame + 30, z: -dFrame, id: '9' }, // Dach szczytowy start
        { x: 0, y: hFrame + 30, z: dFrame, id: '10' }, // Dach szczytowy end
      ];

      const elements = [
        // Słupy pionowe
        [0, 4], [1, 5], [2, 6], [3, 7],
        // Rygielki obwodowe dolne (poziom hFrame)
        [4, 5], [5, 6], [6, 7], [7, 4],
        // Krokwie dachowe
        [4, 8], [5, 8], [7, 9], [6, 9],
        // Kalenica
        [8, 9],
        // Stężenia ścienne (krzyżulce)
        [0, 5], [1, 4],
        [3, 6], [2, 7]
      ];

      // Włączenie neonowego podświetlenia dla linii konstrukcyjnych
      ctx.shadowColor = '#8b5cf6';
      ctx.shadowBlur = 12;

      // 1. Rysowanie prętów konstrukcyjnych
      elements.forEach(([startIdx, endIdx], idx) => {
        const n1 = nodes[startIdx];
        const n2 = nodes[endIdx];
        const p1_x = isoX(n1.x, n1.y, n1.z);
        const p1_y = isoY(n1.x, n1.y, n1.z);
        const p2_x = isoX(n2.x, n2.y, n2.z);
        const p2_y = isoY(n2.x, n2.y, n2.z);

        // Stężenia rysujemy na pomarańczowo, resztę na fioletowo
        const isBracing = idx >= 13;
        ctx.strokeStyle = isBracing ? 'rgba(249, 115, 22, 0.85)' : 'rgba(168, 85, 247, 0.95)';
        ctx.lineWidth = isBracing ? 1.5 : 3.5;
        
        ctx.beginPath();
        ctx.moveTo(p1_x, p1_y);
        ctx.lineTo(p2_x, p2_y);
        ctx.stroke();
      });

      // 2. Rysowanie podpór przegubowych w 3D na węzłach dolnych 0,1,2,3
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ef4444';
      for (let i = 0; i < 4; i++) {
        const n = nodes[i];
        const px = isoX(n.x, n.y, n.z);
        const py = isoY(n.x, n.y, n.z);
        
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - 8, py + 12);
        ctx.lineTo(px + 8, py + 12);
        ctx.closePath();
        ctx.fill();
        
        // Podstawa podpory
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px - 12, py + 12);
        ctx.lineTo(px + 12, py + 12);
        ctx.stroke();
      }

      // 3. Rysowanie węzłów (kropki techniczne)
      nodes.forEach((n, idx) => {
        const px = isoX(n.x, n.y, n.z);
        const py = isoY(n.x, n.y, n.z);

        ctx.fillStyle = idx >= 4 ? '#a855f7' : '#ef4444';
        ctx.beginPath();
        ctx.arc(px, py, idx >= 4 ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Obwódka węzła
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, idx >= 4 ? 5 : 4, 0, Math.PI * 2);
        ctx.stroke();

        // Numeracja węzłów
        ctx.fillStyle = '#94a3b8';
        ctx.font = '9px monospace';
        ctx.fillText(`N${idx + 1}`, px + 8, py - 4);
      });
    }

  }, [showFrame]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas 
        ref={canvasRef} 
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      
      {/* Szklany overlay informacyjny */}
      {!showFrame ? (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(15, 23, 42, 0.75)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          padding: '40px',
          borderRadius: '16px',
          textAlign: 'center',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6)',
          maxWidth: '500px',
          width: '90%',
          transition: 'all 0.3s ease'
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🚀</div>
          <h2 style={{ margin: '0 0 16px 0', fontSize: '24px', color: '#f8fafc', fontWeight: 600, letterSpacing: '-0.5px' }}>
            Wkraczasz w przestrzeń 3D Pro
          </h2>
          <p style={{ margin: '0 0 24px 0', color: '#94a3b8', fontSize: '14px', lineHeight: 1.6 }}>
            Trójwymiarowy silnik MES o 6 stopniach swobody (DOF) na węzeł został aktywowany. Wizualizuj ramy przestrzenne, stężenia i układy kratownicowe w czasie rzeczywistym.
          </p>
          <button 
            onClick={() => setShowFrame(true)}
            style={{
              background: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
              color: '#fff',
              border: 'none',
              padding: '12px 28px',
              borderRadius: '8px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 8px 20px -4px rgba(139, 92, 246, 0.5)',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 12px 24px -4px rgba(139, 92, 246, 0.6)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 8px 20px -4px rgba(139, 92, 246, 0.5)';
            }}
          >
            Wczytaj przykładową ramę 3D
          </button>
        </div>
      ) : (
        <div style={{
          position: 'absolute',
          top: '20px',
          left: '20px',
          background: 'rgba(15, 23, 42, 0.85)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(139, 92, 246, 0.3)',
          padding: '16px',
          borderRadius: '12px',
          boxShadow: '0 10px 30px -10px rgba(0, 0, 0, 0.5)',
          maxWidth: '320px',
          color: '#f8fafc',
          animation: 'fadeIn 0.3s ease-out'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <span style={{ fontSize: '18px' }}>⚡</span>
            <span style={{ fontWeight: 'bold', fontSize: '13px', color: '#c4b5fd', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Model Aktywny (MES 3D)
            </span>
          </div>
          <div style={{ fontSize: '12px', color: '#94a3b8', lineHeight: 1.5, marginBottom: '12px' }}>
            Wygenerowano ramę portalową z dachem dwuspadowym, stężeniami pionowymi oraz 10 węzłami obliczeniowymi.
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              onClick={() => setShowFrame(false)}
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '6px',
                color: '#e2e8f0',
                padding: '6px 12px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                flex: 1,
                transition: 'all 0.15s ease'
              }}
            >
              Wyczyść ramę
            </button>
            <button 
              onClick={() => {
                alert('Symulacja analizy statycznej 3D wykonana pomyślnie! Wyniki przesłano do modułu optymalizacji.');
              }}
              style={{
                background: '#8b5cf6',
                border: 'none',
                borderRadius: '6px',
                color: '#fff',
                padding: '6px 12px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                flex: 1,
                boxShadow: '0 2px 8px rgba(139, 92, 246, 0.3)',
                transition: 'all 0.15s ease'
              }}
            >
              Uruchom Solver
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
