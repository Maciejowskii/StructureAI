const fs = require('fs');
let content = fs.readFileSync('apps/web/src/App.tsx', 'utf-8');

// 1. Fix STEEL_PROFILES_3D
content = content.replace(/STEEL_PROFILES_3D: Record<string, \{ area: number, iy: number, iz: number, j: number, wy: number, wz: number \}> = \{([\s\S]*?)\};/m, (match, p1) => {
    let newObj = p1.replace(/(\d+(\.\d+)?)e-4/g, '$1');
    newObj = newObj.replace(/(\d+(\.\d+)?)e-8/g, '$1');
    newObj = newObj.replace(/(\d+(\.\d+)?)e-6/g, '$1');
    return 'STEEL_PROFILES_3D: Record<string, { area: number, iy: number, iz: number, j: number, wy: number, wz: number }> = {' + newObj + '};';
});

// 2. Fix generateParametricModel3D
content = content.replace(/\.\.\.colProps, groupId: "columns"/g, '...colProps, iy: colProps.iy * 1e-8, iz: colProps.iz * 1e-8, area: colProps.area * 1e-4, wy: colProps.wy * 1e-6, wz: colProps.wz * 1e-6, groupId: "columns"');
content = content.replace(/\.\.\.rafProps, groupId: "rafters"/g, '...rafProps, iy: rafProps.iy * 1e-8, iz: rafProps.iz * 1e-8, area: rafProps.area * 1e-4, wy: rafProps.wy * 1e-6, wz: rafProps.wz * 1e-6, groupId: "rafters"');
content = content.replace(/\.\.\.braceProps, groupId: "bracings"/g, '...braceProps, iy: braceProps.iy * 1e-8, iz: braceProps.iz * 1e-8, area: braceProps.area * 1e-4, wy: braceProps.wy * 1e-6, wz: braceProps.wz * 1e-6, groupId: "bracings"');

// 3. Fix updateElementProfile
content = content.replace(/iy: props\.iy,\s*iz: props\.iz,\s*area: props\.area,\s*wy: props\.wy,\s*wz: props\.wz/g, 'iy: props.iy * 1e-8,\n          iz: props.iz * 1e-8,\n          area: props.area * 1e-4,\n          wy: props.wy * 1e-6,\n          wz: props.wz * 1e-6');

// 4. Fix handleAddElement3D
content = content.replace(/\.\.\.defaultProps,\s*sectionId: rafterSection,\s*groupId: "rafters"/g, '...defaultProps,\n        iy: defaultProps.iy * 1e-8,\n        iz: defaultProps.iz * 1e-8,\n        area: defaultProps.area * 1e-4,\n        wy: defaultProps.wy * 1e-6,\n        wz: defaultProps.wz * 1e-6,\n        sectionId: rafterSection,\n        groupId: "rafters"');

// 5. Hide 2D tabs in 3D mode
// We need to find the sidebar and conditionally render the appMode switch
content = content.replace(/<div className="sidebar-tabs">([\s\S]*?)<\/div>/m, (match) => {
    // wait, we only hide 2D tabs in 3D mode? 
    // "Jeśli 'appMode === "3d"', ukryj górny przełącznik "Stal (Optymalizacja) / Żelbet (EC2)" oraz panel 2D."
    // "Cały Sidebar w trybie 3D musi być dedykowany wyłącznie pod projektowanie 3D Pro"
    return match; // We will do this via a multi_replace instead or improve regex
});

// 6. Reset button for Free CAD
content = content.replace(/<button\s+onClick=\{\(\) => setWorkMode3D\('free_cad'\)\}[\s\S]*?✏️ Edytor Wolny CAD\s*<\/button>/m, (match) => {
    return match + `
              </div>
              {workMode3D === 'free_cad' && (
                <div style={{ padding: '0 15px', marginBottom: '10px' }}>
                  <button
                    onClick={() => setFreeModel3D(null)}
                    style={{
                      width: '100%',
                      padding: '8px',
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid rgba(239, 68, 68, 0.3)',
                      color: '#ef4444',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '12px',
                    }}
                  >
                    🔄 Resetuj układ do Kreatora
                  </button>
                </div>
              )}`;
});

// Remove </div> from the matched since we added it?
// Wait, the match was just the button. The </div> is after the button.
// Actually let's just do it cleanly with multi_replace_file_content

fs.writeFileSync('apps/web/src/App.tsx', content);
console.log('Done script');
