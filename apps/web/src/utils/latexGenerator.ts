/**
 * StructurAI Dynamics - Generator Raportów LaTeX (White-Box)
 * Wersja: 1.0.0
 */

/**
 * Generuje kompletny raport LaTeX dla wymiarowania belki stalowej.
 */
export function generateSteelReport(
  moment_kNm: number,
  profileName: string,
  wy_cm3: number,
  fy_MPa: number,
  utilization: number,
  deflection_mm?: number,
  limit_sgu_mm?: number
): string {
  const moment_Nm = Math.abs(moment_kNm) * 1000.0;
  const wy_m3 = wy_cm3 * 1e-6;
  const stress_Pa = moment_Nm / wy_m3;
  const stress_MPa = stress_Pa / 1e6;
  
  const sgnPassed = utilization <= 1.0;
  const sguPassed = deflection_mm !== undefined && limit_sgu_mm !== undefined ? deflection_mm <= limit_sgu_mm : true;

  return `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[polish]{babel}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{geometry}
\\usepackage{booktabs}
\\usepackage{fancyhdr}
\\usepackage{color}

\\geometry{a4paper, margin=25mm}

\\pagestyle{fancy}
\\fancyhf{}
\\rhead{StructurAI Dynamics}
\\lhead{Raport Techniczny: Wymiarowanie Stalowe}
\\cfoot{\\thepage}

\\definecolor{darkgreen}{rgb}{0,0.6,0}
\\definecolor{darkred}{rgb}{0.8,0,0}

\\begin{document}

\\begin{center}
    {\\LARGE \\bf RAPORT TECHNICZNY - WYMIAROWANIE STALOWE}\\\\[0.5cm]
    {\\large Wygenerowano automatycznie w programie \\textbf{StructurAI Dynamics}}\\\\[0.2cm]
    \\today
\\end{center}

\\vspace{1cm}

\\section{Opis Przekroju i Materiału}
Do obliczeń przyjęto standardowy profil stalowy:
\\begin{itemize}
    \\item \\textbf{Nazwa przekroju:} ${profileName}
    \\item \\textbf{Wskaźnik oporu przekroju na zginanie ($W_y$):} $W_y = ${wy_cm3.toFixed(2)} \\text{ cm}^3 = ${wy_m3.toExponential(4)} \\text{ m}^3$
    \\item \\textbf{Gatunek stali:} S${fy_MPa}
    \\item \\textbf{Granica plastyczności ($f_y$):} $f_y = ${fy_MPa} \\text{ MPa}$
\\end{itemize}

\\section{Obciążenia i Siły Wewnętrzne}
Na podstawie obliczeń MES (Metoda Elementów Skończonych) określono ekstremalne siły wewnętrzne:
\\begin{itemize}
    \\item \\textbf{Maksymalny obliczeniowy moment zginający ($M_{Ed}$):} $M_{Ed} = ${Math.abs(moment_kNm).toFixed(2)} \\text{ kNm} = ${moment_Nm.toFixed(0)} \\text{ Nm}$
\\end{itemize}

\\section{Stan Graniczny Nośności (SGN)}
Weryfikacja naprężeń normalnych przy czystym zginaniu wg normy PN-EN 1993-1-1:
\\[
\\sigma_{max} = \\frac{M_{Ed}}{W_y}
\\]

Podstawiając wartości obliczeniowe:
\\[
\\sigma_{max} = \\frac{${moment_Nm.toFixed(0)} \\text{ Nm}}{${wy_m3.toExponential(4)} \\text{ m}^3} = ${stress_Pa.toFixed(0)} \\text{ Pa} = ${stress_MPa.toFixed(2)} \\text{ MPa}
\\]

Warunek nośności przekroju:
\\[
\\eta_{SGN} = \\frac{\\sigma_{max}}{f_y} \\le 1.0
\\]
\\[
\\eta_{SGN} = \\frac{${stress_MPa.toFixed(2)} \\text{ MPa}}{${fy_MPa} \\text{ MPa}} = ${utilization.toFixed(4)} \\quad (${(utilization * 100).toFixed(2)}\\%)
\\]

\\vspace{0.3cm}
\\noindent
\\textbf{Wynik weryfikacji SGN:} 
${
  sgnPassed
    ? '\\textcolor{darkgreen}{\\textbf{WARUNEK SPEŁNIONY} (Wytężenie $\\le 100\\%$)}'
    : '\\textcolor{darkred}{\\textbf{WARUNEK PRZEKROCZONY} (Przekrój ma niewystarczającą nośność!)}'
}

${
  deflection_mm !== undefined && limit_sgu_mm !== undefined
    ? `
\\section{Stan Graniczny Użytkowalności (SGU)}
Weryfikacja maksymalnego ugięcia belki sprężystej:
\\begin{itemize}
    \\item \\textbf{Maksymalne ugięcie obliczone ($u_{max}$):} $u_{max} = ${Math.abs(deflection_mm).toFixed(2)} \\text{ mm}$
    \\item \\textbf{Dopuszczalne ugięcie graniczne ($u_{lim} = L/250$):} $u_{lim} = ${limit_sgu_mm.toFixed(2)} \\text{ mm}$
\\end{itemize}

Warunek użytkowalności:
\\[
\\eta_{SGU} = \\frac{u_{max}}{u_{lim}} \\le 1.0
\\]
\\[
\\eta_{SGU} = \\frac{${Math.abs(deflection_mm).toFixed(2)} \\text{ mm}}{${limit_sgu_mm.toFixed(2)} \\text{ mm}} = ${(deflection_mm / limit_sgu_mm).toFixed(4)} \\quad (${((deflection_mm / limit_sgu_mm) * 100).toFixed(2)}\\%)
\\]

\\vspace{0.3cm}
\\noindent
\\textbf{Wynik weryfikacji SGU:} 
${
  sguPassed
    ? '\\textcolor{darkgreen}{\\textbf{WARUNEK SPEŁNIONY} (Ugięcie w dopuszczalnym zakresie)}'
    : '\\textcolor{darkred}{\\textbf{WARUNEK PRZEKROCZONY} (Przekroczone ugięcie dopuszczalne!)}'
}
`
    : ''
}

\\section{Podsumowanie i Wnioski}
Zastosowany profil \\textbf{${profileName}} charakteryzuje się stopniem wytężenia nośności wynoszącym \\textbf{${(utilization * 100).toFixed(1)}\\%}${
    deflection_mm !== undefined && limit_sgu_mm !== undefined 
      ? ` oraz stopniem wykorzystania ugięcia wynoszącym \\textbf{${((deflection_mm / limit_sgu_mm) * 100).toFixed(1)}\\%}` 
      : ''
  }. 
Przekrój jest ${sgnPassed && sguPassed ? '\\textcolor{darkgreen}{\\textbf{ODPOWIEDNI}}' : '\\textcolor{darkred}{\\textbf{NIEODPOWIEDNI}}'} do bezpiecznego przenoszenia zadanych obciążeń konstrukcyjnych.

\\end{document}
`;
}

/**
 * Generuje kompletny raport LaTeX dla wymiarowania przekroju żelbetowego wg Eurokodu 2.
 */
export function generateConcreteReport(
  moment_kNm: number,
  width_cm: number,
  height_cm: number,
  cover_cm: number,
  fck_MPa: number,
  fyk_MPa: number,
  d_m: number,
  mi: number,
  asReq_cm2: number,
  asMin_cm2: number,
  isOverreinforced: boolean
): string {
  const b_m = width_cm / 100.0;
  const h_m = height_cm / 100.0;
  const cover_m = cover_cm / 100.0;

  const fcd_MPa = fck_MPa / 1.5;
  const fyd_MPa = fyk_MPa / 1.15;
  
  const moment_MNm = Math.abs(moment_kNm) / 1000.0;

  // Re-calculate intermediate values for equations in LaTeX
  const xi = 1.25 * (1.0 - Math.sqrt(Math.max(0.0, 1.0 - 2.0 * mi)));
  const z_m = d_m * (1.0 - 0.4 * xi);

  const fctm_MPa = 0.3 * Math.pow(fck_MPa, 2.0 / 3.0);

  const asFinal_cm2 = isOverreinforced ? 0.0 : Math.max(asReq_cm2, asMin_cm2);

  return `\\documentclass[12pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[polish]{babel}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{geometry}
\\usepackage{booktabs}
\\usepackage{fancyhdr}
\\usepackage{color}

\\geometry{a4paper, margin=25mm}

\\pagestyle{fancy}
\\fancyhf{}
\\rhead{StructurAI Dynamics}
\\lhead{Raport Techniczny: Żelbet EC2}
\\cfoot{\\thepage}

\\definecolor{darkgreen}{rgb}{0,0.6,0}
\\definecolor{darkred}{rgb}{0.8,0,0}

\\begin{document}

\\begin{center}
    {\\LARGE \\bf RAPORT TECHNICZNY - WYMIAROWANIE ŻELBETU}\\\\[0.5cm]
    {\\large Wymiarowanie przekroju zginanego wg PN-EN 1992-1-1 (Eurokod 2)}\\\\[0.2cm]
    {\\large Wygenerowano w programie \\textbf{StructurAI Dynamics}}\\\\[0.2cm]
    \\today
\\end{center}

\\vspace{0.8cm}

\\section{Dane Materiałowe i Geometryczne}
Do weryfikacji przyjęto prostokątny przekrój żelbetowy o następujących parametrach:

\\subsection{Geometria przekroju}
\\begin{itemize}
    \\item Szerokość przekroju ($b$): $b = ${width_cm.toFixed(1)} \\text{ cm} = ${b_m.toFixed(2)} \\text{ m}$
    \\item Wysokość przekroju ($h$): $h = ${height_cm.toFixed(1)} \\text{ cm} = ${h_m.toFixed(2)} \\text{ m}$
    \\item Otulina zbrojenia ($c_{nom}$): $c_{nom} = ${cover_cm.toFixed(1)} \\text{ cm} = ${cover_m.toFixed(3)} \\text{ m}$
\\end{itemize}

\\subsection{Parametry materiałowe}
\\begin{itemize}
    \\item Klasa betonu: \\textbf{C${fck_MPa}/${(fck_MPa * 1.2).toFixed(0)}} 
    \\item Wytrzymałość charakterystyczna betonu na ściskanie ($f_{ck}$): $f_{ck} = ${fck_MPa.toFixed(1)} \\text{ MPa}$
    \\item Wytrzymałość obliczeniowa betonu ($f_{cd}$):
    \\[
    f_{cd} = \\frac{f_{ck}}{\\gamma_C} = \\frac{${fck_MPa.toFixed(1)}}{1.5} = ${fcd_MPa.toFixed(2)} \\text{ MPa}
    \\]
    \\item Średnia wytrzymałość betonu na rozciąganie ($f_{ctm}$):
    \\[
    f_{ctm} = 0.3 \\cdot f_{ck}^{2/3} = 0.3 \\cdot ${fck_MPa.toFixed(1)}^{2/3} = ${fctm_MPa.toFixed(2)} \\text{ MPa}
    \\]
    \\item Charakterystyczna granica plastyczności stali ($f_{yk}$): $f_{yk} = ${fyk_MPa.toFixed(0)} \\text{ MPa}$
    \\item Obliczeniowa granica plastyczności stali ($f_{yd}$):
    \\[
    f_{yd} = \\frac{f_{yk}}{\\gamma_S} = \\frac{${fyk_MPa.toFixed(0)}}{1.15} = ${fyd_MPa.toFixed(2)} \\text{ MPa}
    \\]
\\end{itemize}

\\section{Siły Wewnętrzne}
Maksymalny obliczeniowy moment zginający w przekroju (wyznaczony z analizy MES):
\\[
M_{Ed} = ${Math.abs(moment_kNm).toFixed(2)} \\text{ kNm} = ${moment_MNm.toFixed(5)} \\text{ MNm}
\\]

\\section{Procedura Wymiarowania (Eurokod 2)}

\\subsection{Wysokość użyteczna przekroju ($d$)}
Zakładając zbrojenie jednorzędowe i szacunkową średnicę prętów zbrojeniowych $\\phi = 20\\text{ mm}$, wysokość użyteczna $d$ wynosi:
\\[
d = h - c_{nom} - \\frac{\\phi}{2} = h - c_{nom} - 0.01 \\text{ m}
\\]
\\[
d = ${h_m.toFixed(2)} - ${cover_m.toFixed(3)} - 0.01 = ${d_m.toFixed(3)} \\text{ m}
\\]

\\subsection{Względny moment zginający ($\\mu$)}
Bezwymiarowy współczynnik momentu względnego $\\mu$:
\\[
\\mu = \\frac{M_{Ed}}{b \\cdot d^2 \\cdot f_{cd}}
\\]
\\[
\\mu = \\frac{${moment_MNm.toFixed(5)} \\text{ MNm}}{${b_m.toFixed(2)} \\text{ m} \\cdot ${d_m.toFixed(3)}^2 \\text{ m}^2 \\cdot ${fcd_MPa.toFixed(2)} \\text{ MPa}} = \\frac{${moment_MNm.toFixed(5)}}{${(b_m * d_m * d_m * fcd_MPa).toFixed(5)}} = ${mi.toFixed(4)}
\\]

\\subsection{Weryfikacja stanu przebrojenia}
Zgodnie z polskim załącznikiem krajowym do PN-EN 1992-1-1 graniczny względny moment zginający dla przekroju bez zbrojenia ściskanego wynosi $\\mu_{lim} = 0.372$.
\\[
\\mu = ${mi.toFixed(4)} \\quad \\text{vs} \\quad \\mu_{lim} = 0.372
\\]

\\vspace{0.3cm}
\\noindent
\\textbf{Status przebrojenia:} 
${
  isOverreinforced
    ? '\\textcolor{darkred}{\\textbf{PRZEKROCZONY! przekrój jest przebrojony ($\\mu > 0.372$).} Wymagane jest zwiększenie wysokości/szerokości belki lub zastosowanie wyższej klasy betonu.}'
    : '\\textcolor{darkgreen}{\\textbf{POPRAWNY} ($\\mu \\le 0.372$ - przekrój poprawnie zwymiarowany bez zbrojenia ściskanego).}'
}

${
  !isOverreinforced
    ? `
\\subsection{Wyznaczenie strefy ściskanej i ramienia sił}
Względna wysokość strefy ściskanej $\\xi$:
\\[
\\xi = 1.25 \\cdot \\left( 1 - \\sqrt{1 - 2 \\cdot \\mu} \\right)
\\]
\\[
\\xi = 1.25 \\cdot \\left( 1 - \\sqrt{1 - 2 \\cdot ${mi.toFixed(4)}} \\right) = ${xi.toFixed(4)}
\\]

Ramię sił wewnętrznych $z$:
\\[
z = d \\cdot \\left( 1 - 0.4 \\cdot \\xi \\right)
\\]
\\[
z = ${d_m.toFixed(3)} \\text{ m} \\cdot \\left( 1 - 0.4 \\cdot ${xi.toFixed(4)} \\right) = ${z_m.toFixed(3)} \\text{ m}
\\]

\\subsection{Wymagane pole zbrojenia rozciąganego ($A_{s,req}$)}
Pole powierzchni przekroju zbrojenia wymagane ze względów nośności:
\\[
A_{s,req} = \\frac{M_{Ed}}{z \\cdot f_{yd}}
\\]
\\[
A_{s,req} = \\frac{${moment_MNm.toFixed(5)} \\text{ MNm}}{${z_m.toFixed(3)} \\text{ m} \\cdot ${fyd_MPa.toFixed(2)} \\text{ MPa}} = ${(moment_MNm / (z_m * fyd_MPa)).toExponential(6)} \\text{ m}^2 = ${asReq_cm2.toFixed(2)} \\text{ cm}^2
\\]

\\subsection{Zbrojenie minimalne ($A_{s,min}$)}
Zgodnie z normą PN-EN 1992-1-1 minimalne pole zbrojenia rozciąganego wynosi:
\\[
A_{s,min} = \\max \\left( 0.26 \\cdot \\frac{f_{ctm}}{f_{yk}} \\cdot b \\cdot d, \\; 0.0013 \\cdot b \\cdot d \\right)
\\]
Podstawiając wartości:
\\[
0.26 \\cdot \\frac{${fctm_MPa.toFixed(2)} \\text{ MPa}}{${fyk_MPa.toFixed(0)} \\text{ MPa}} \\cdot ${b_m.toFixed(2)} \\text{ m} \\cdot ${d_m.toFixed(3)} \\text{ m} = ${(0.26 * (fctm_MPa / fyk_MPa) * b_m * d_m * 10000.0).toFixed(2)} \\text{ cm}^2
\\]
\\[
0.0013 \\cdot ${b_m.toFixed(2)} \\text{ m} \\cdot ${d_m.toFixed(3)} \\text{ m} = ${(0.0013 * b_m * d_m * 10000.0).toFixed(2)} \\text{ cm}^2
\\]
\\[
A_{s,min} = ${asMin_cm2.toFixed(2)} \\text{ cm}^2
\\]
`
    : ''
}

\\subsection{Ostateczny dobór zbrojenia}
Ostatecznie, minimalne wymagane normowo i wytrzymałościowo pole zbrojenia rozciąganego wynosi:
\\[
A_{s} = \\max(A_{s,req}, A_{s,min})
\\]
${
  isOverreinforced
    ? '\\[ A_{s} = \\text{\\textcolor{darkred}{Przekrój przebrojony! Obliczenia niemożliwe.}} \\]'
    : `\\[ A_{s} = \\max(${asReq_cm2.toFixed(2)}, ${asMin_cm2.toFixed(2)}) = \\mathbf{${asFinal_cm2.toFixed(2)} \\text{ cm}^2} \\]`
}

\\section{Weryfikacja Końcowa i Rekomendacje}
Przekrój prostokątny o wymiarach $${width_cm.toFixed(0)} \\times ${height_cm.toFixed(0)}$ cm pod działaniem momentu zginającego $M_{Ed} = ${Math.abs(moment_kNm).toFixed(1)}$ kNm:
\\begin{itemize}
    \\item ${
      isOverreinforced
        ? '\\textcolor{darkred}{\\textbf{NIE SPEŁNIA WARUNKÓW} Eurokodu 2 (przebrojenie).}'
        : '\\textcolor{darkgreen}{\\textbf{SPEŁNIA WARUNKY} Eurokodu 2 pod warunkiem zastosowania zbrojenia o polu przekroju minimum \\textbf{' + asFinal_cm2.toFixed(2) + ' cm}^2}.'
    }
    ${
      !isOverreinforced
        ? `\\item Szacunkowa liczba prętów (np. $\\phi 16$ o polu $2.01 \\text{ cm}^2$): \\textbf{${Math.ceil(asFinal_cm2 / 2.011)} prętów $\\phi 16$} (łącznie $${(Math.ceil(asFinal_cm2 / 2.011) * 2.011).toFixed(2)} \\text{ cm}^2$).`
        : ''
    }
\\end{itemize}

\\end{document}
`;
}
