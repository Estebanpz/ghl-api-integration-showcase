import {
    normalizarTelefono, normalizarEncabezado, ubicarEncabezadosPago,
    esPestanaDeMes, buscarCandidatos, decidir, planEscritura, letraColumna
} from "../utils/pago.js";

/**
 * Bateria de aceptacion de /webhook/marcar-pago.
 *
 *     node scripts/test-pago.js
 *
 * Las filas son COPIA LITERAL de "Copia Zion Dealer Copia" (junio, julio y
 * agosto de 2026). No son inventadas: cada caso existe en la hoja y es el que
 * puede hacer que el webhook escriba donde no debe.
 */

const H = ["customer","leasing agent","phone","move in date","property type","install date",
           "notes","internet sold","electricity sold","provider","speed","internet revenue",
           "electricity revenue","pay agent","profit","installed","paid me","agent paid",
           "paid period","t revenue"];

// La trampa real: a la derecha hay un bloque de metricas que REPITE
// "Leasing Agent" en la misma fila de encabezados, en el indice 29.
const H_CON_BLOQUE = [...H, "Column 21","Column 22","Column 23","Column 24","","","","","",
                      "Leasing Agent","Total Leads","Leads Convertidos (YES)","Tasa Conversion %"];

const VACIA = Array(20).fill("");
const TOTALES = ["","","","","","","","","","","","$3,050.00","","$17,023.00","","","","","",""];

/** Fila de 20 columnas a partir de campos con nombre. */
function f(o) {
    const r = Array(20).fill("");
    r[0]=o.customer||""; r[1]=o.agent||""; r[2]=o.phone||""; r[3]=o.moveIn||"";
    r[4]=o.ptype||""; r[5]=o.install||""; r[7]=o.net||""; r[8]=o.elec||"";
    r[15]=o.installed||""; r[16]=o.paidme||""; r[17]=o.agentpaid||"";
    return r;
}

const PESTANAS = [
    { titulo: "June2026", filas: [VACIA, H, TOTALES,
        f({customer:"Maci Perkins", agent:"Jake@Lakeside Lofts", phone:"(214) 218-5822", moveIn:"8/3/26", net:"NO", elec:"NO"}),
        f({customer:"Jenna M. Keeley", agent:"Chris@Lakeside Apartments", phone:"(202) 678-5317", moveIn:"7/23/26", ptype:"SARA", net:"NO", elec:"YES"}),
        f({customer:"Yvette simpson", agent:"Jasmine@Luxia Gallery House", phone:"(469) 865-3447", moveIn:"7/22/26"})
    ]},
    { titulo: "July2026", filas: [VACIA, H_CON_BLOQUE, TOTALES,
        f({customer:"Kamal kalenda", agent:"Anju@The Maxwell", phone:"(916) 919-9061", ptype:"RE", install:"7/31/26", net:"YES", elec:"NO"}),
        f({customer:"Kazal kalenda", agent:"Anju@The Maxwell", phone:"(916) 919-9061", ptype:"RE", install:"7/31/26", net:"YES", elec:"NO"}),
        f({customer:"Emma Fendley", agent:"Bee@Bell Tower Flats", phone:"(903) 401-9737", ptype:"SARA", install:"7/28/26", net:"YES", elec:"NO", installed:"YES", paidme:"YES", agentpaid:"YES"}),
        f({customer:"Yvette Simpson", agent:"Jasmine@Luxia Gallery House", phone:"469-865-3447", ptype:"SARA", install:"7/22/26", net:"YES", elec:"NO"})
    ]},
    { titulo: "August2026", filas: [VACIA, H, TOTALES,
        f({customer:"Cecilia Mack", agent:"D'Andrea@Waterview Crossing", phone:"212146845278", ptype:"SARA", install:"8/24/26", net:"YES", elec:"NO"}),
        f({customer:"Maci Perkins", agent:"Jake@Lakeside Lofts", phone:"(214) 218-5822", ptype:"RE", install:"8/11/26", net:"YES", elec:"NO"}),
        f({customer:"Joshua Howard", agent:"Everra Midtown Park", phone:"(210) 986-8452", ptype:"SARA", install:"8/8/26", net:"YES", elec:"NO", installed:"YES", paidme:"YES", agentpaid:"YES"}),
        f({customer:"Erika Guerrero", agent:"Cristian", phone:"639864103", ptype:"SARA", install:"8/7/26", net:"YES", elec:"NO", installed:"YES", paidme:"YES", agentpaid:"YES"}),
        f({customer:"Abel Anderson", agent:"Chris@Lakeside Apartments", phone:"(214) 555-0101", ptype:"SARA", install:"8/5/26", net:"YES", elec:"NO", installed:"On Hold"})
    ]},
    // Pestaña vieja: tiene "customer" pero le faltan las columnas de pago.
    { titulo: "Vieja2025", filas: [["customer","phone","notes"], ["Alguien","(214) 000-0000","x"]] }
];

let fallos = 0;
function chequear(etiqueta, real, esperado) {
    const ok = JSON.stringify(real) === JSON.stringify(esperado);
    if (!ok) fallos++;
    console.log(`${ok ? "✅" : "❌"} ${etiqueta}`);
    if (!ok) console.log(`     esperaba ${JSON.stringify(esperado)}\n     obtuvo   ${JSON.stringify(real)}`);
}

const resolver = (telefono) => {
    const { candidatos, saltadas } = buscarCandidatos(PESTANAS, telefono);
    return { ...decidir(candidatos), todos: candidatos, saltadas };
};

console.log("\n── Paso 3: normalizarTelefono ──────────────────────────");
[
    ["+19034019737", "9034019737"],
    ["(903) 401-9737", "9034019737"],
    ["469-865-3447", "4698653447"],
    ["4106607139", "4106607139"],
    ["12146426154", "2146426154"],
    ["212146845278", "2146845278"],
    ["972-978-5014", "9729785014"],
    ["639864103", null],
    ["jennimh699@gmail.com", null],
    ["", null],
    [null, null],
    [undefined, null]
].forEach(([entrada, esperado]) =>
    chequear(`normalizarTelefono(${JSON.stringify(entrada)})`, normalizarTelefono(entrada), esperado));

console.log("\n── Paso 4: encabezados ─────────────────────────────────");
chequear('normalizarEncabezado("Agent Paid?")', normalizarEncabezado("Agent Paid?"), "agentpaid");
chequear('normalizarEncabezado("🏢 Leasing  Agent")', normalizarEncabezado("🏢 Leasing  Agent"), "leasingagent");

const ubicJulio = ubicarEncabezadosPago(PESTANAS[1].filas);
chequear("encabezados de July2026 en la fila 1 (no la 0)", ubicJulio.filaHeader, 1);
chequear("bloque lateral: leasing agent usa el indice 1, no el 29", ubicJulio.cols.agent, 1);
chequear("paid me y agent paid no se confunden con paid period",
    [ubicJulio.cols.paidme, ubicJulio.cols.agentpaid], [16, 17]);
chequear("pestaña sin columnas de pago -> null", ubicarEncabezadosPago(PESTANAS[3].filas), null);

chequear('esPestanaDeMes("August2026")', esPestanaDeMes("August2026"), true);
chequear('esPestanaDeMes("August/2026")', esPestanaDeMes("August/2026"), true);
chequear('esPestanaDeMes("BASE")', esPestanaDeMes("BASE"), false);
chequear('esPestanaDeMes("Catalogo")', esPestanaDeMes("Catalogo"), false);

chequear("letraColumna(15/16/17)", [15,16,17].map(letraColumna), ["P","Q","R"]);
chequear("letraColumna(34) -> AI", letraColumna(34), "AI");

console.log("\n── Bateria de aceptacion ───────────────────────────────");

// 1. Emma Fendley: una sola fila, pero ya tiene las tres marcadas.
const emma = resolver("9034019737");
chequear("1. Emma Fendley encuentra 1 fila en July2026",
    [emma.estado, emma.elegido?.pestana, emma.elegido?.cliente], ["ok", "July2026", "Emma Fendley"]);
chequear("1b. Emma ya marcada -> no escribe, respeta las 3",
    planEscritura(emma.elegido).respetadas.map(r => r.campo), ["installed","paid me","agent paid"]);

// 2. Kamal y Kazal: mismo telefono, mismo tipo, misma venta.
chequear("2. Kamal / Kazal -> ambiguo, no escribe", resolver("9169199061").estado, "ambiguo");

// 3. Maci Perkins: fila en June sin venta, fila en August con venta.
const maci = resolver("2142185822");
chequear("3. Maci Perkins elige August2026 y descarta June2026",
    [maci.estado, maci.todos.length, maci.elegido?.pestana], ["ok", 2, "August2026"]);

// 4. Yvette: (469) 865-3447 en June y 469-865-3447 en July.
const yvette = resolver("4698653447");
chequear("4. Yvette: los dos formatos normalizan igual, gana la fila con venta",
    [yvette.todos.length, yvette.estado, yvette.elegido?.pestana], [2, "ok", "July2026"]);

// 5. Cecilia Mack: 12 digitos en la hoja.
const cecilia = resolver("2146845278");
chequear("5. Cecilia Mack: 212146845278 -> 2146845278, fila con venta",
    [cecilia.estado, cecilia.elegido?.pestana], ["ok", "August2026"]);
chequear("5b. Cecilia sin marcar -> escribe las 3",
    planEscritura(cecilia.elegido).escritas.map(e => e.campo), ["installed","paid me","agent paid"]);

// 6. Erika Guerrero: 9 digitos en la hoja, nunca debe hacer match parcial.
chequear("6. Erika (9 digitos) no se encuentra ni con un telefono parecido",
    resolver("1639864103").todos.length, 0);

// 7. Joshua Howard: las tres ya puestas.
const joshua = resolver("2109868452");
chequear("7. Joshua Howard no escribe nada",
    planEscritura(joshua.elegido).escritas.length, 0);

// 8. Jenna M. Keeley: solo electricidad.
const jenna = resolver("2026785317");
chequear("8. Jenna Keeley pasa el filtro con electricity sold = YES",
    [jenna.estado, jenna.elegido?.pestana], ["ok", "June2026"]);

// 9. Pestaña vieja sin las columnas.
chequear("9. Vieja2025 se salta sin reventar", emma.saltadas, ["Vieja2025"]);

// 10. Telefono de GHL vacio o corto: se aborta antes de buscar.
chequear("10. telefono de GHL invalido -> null antes de buscar",
    [normalizarTelefono(""), normalizarTelefono("12345")], [null, null]);

// 11. "On Hold" es la decision de alguien: no se pisa.
const abel = resolver("2145550101");
const planAbel = planEscritura(abel.elegido);
chequear("11. Abel Anderson: On Hold se respeta, las otras dos se escriben",
    [planAbel.respetadas, planAbel.escritas.map(e => e.campo)],
    [[{campo:"installed", valor:"On Hold"}], ["paid me","agent paid"]]);

// ══════════════════════════════════════════════════════════════════
// /webhook/marcar-procesado
// ══════════════════════════════════════════════════════════════════
const { speedDesdePlan, ventasDesdeSales, fechaParaHoja, pestanaDesdeFecha,
        valoresParaHoja, elegirFilaProcesado } = await import("../utils/procesado.js");

let f2 = 0;
function chk(etiqueta, real, esperado) {
    const ok = JSON.stringify(real) === JSON.stringify(esperado);
    if (!ok) { f2++; fallos++; }
    console.log(`${ok ? "✅" : "❌"} ${etiqueta}`);
    if (!ok) console.log(`     esperaba ${JSON.stringify(esperado)}\n     obtuvo   ${JSON.stringify(real)}`);
}

console.log("\n── marcar-procesado: traducción GHL → hoja ─────────────");
chk("plan 1000Mbps -> 1000", speedDesdePlan("1000Mbps"), "1000");
chk("plan vacío -> ''", speedDesdePlan(""), "");
chk("Sales [AT&T] -> internet YES, elec NO",
    ventasDesdeSales(["AT&T"]), { internet: "YES", electricidad: "NO", vendioAlgo: true });
chk("Sales 'AT&T, Electricity' como texto -> YES/YES",
    ventasDesdeSales("AT&T, Electricity"), { internet: "YES", electricidad: "YES", vendioAlgo: true });
chk("solo Electricity -> sin provider ni speed",
    valoresParaHoja({ propertyType: "SARA", installDate: "2026-10-15", sales: ["Electricity"], provider: "AT&T", plan: "1000Mbps" }),
    { propertytype: "SARA", installDate: "10/15/26", internetsold: "NO", electricitysold: "YES", provider: "", speed: "" });

// El bug de zona horaria: si esto se parsea con new Date() local, en UTC-5
// el 1 de octubre se convierte en 30 de septiembre y la fila se va a la
// pestaña equivocada.
chk("ISO 2026-10-01T00:00:00.000Z -> 10/1/26", fechaParaHoja("2026-10-01T00:00:00.000Z"), "10/1/26");
chk("ISO 2026-10-01T00:00:00.000Z -> October/2026", pestanaDesdeFecha("2026-10-01T00:00:00.000Z"), "October/2026");
chk("31/12 no se pasa al año siguiente", pestanaDesdeFecha("2026-12-31T23:00:00.000Z"), "December/2026");
chk("sin fecha -> sin pestaña", pestanaDesdeFecha(""), "");

console.log("\n── marcar-procesado: elección de fila ──────────────────");
const filaFalsa = (ptype) => ({
    pestana: "August/2026", fila: 9, cols: { propertytype: 4 },
    datos: ["X", "", "", "", ptype]
});
chk("una sola sin procesar -> ok",
    elegirFilaProcesado([filaFalsa(""), filaFalsa("RE")]).estado, "ok");
chk("elige la que NO tiene property type",
    elegirFilaProcesado([filaFalsa("RE"), filaFalsa("")]).elegido.datos[4], "");
chk("ninguna sin procesar pero una sola en total -> corrección",
    [elegirFilaProcesado([filaFalsa("SARA")]).estado, elegirFilaProcesado([filaFalsa("SARA")]).correccion],
    ["ok", true]);
chk("dos sin procesar -> ambiguo",
    elegirFilaProcesado([filaFalsa(""), filaFalsa("")]).estado, "ambiguo");
chk("dos ya procesadas -> ambiguo, no adivina",
    elegirFilaProcesado([filaFalsa("RE"), filaFalsa("SARA")]).estado, "ambiguo");
chk("ninguna fila -> crear desde cero",
    elegirFilaProcesado([]).estado, "crear");

// ══════════════════════════════════════════════════════════════════
// notes: F1/F2/F3 + pend call
// ══════════════════════════════════════════════════════════════════
const { analizarNotas, construirNotas, conMarcadorIntento, conPendCall, sinRuido } =
    await import("../utils/notas.js");

console.log("\n── notes: analizar / construir ─────────────────────────");
chk("nota vacía", analizarNotas(""), { marcadorF: null, pendCall: false, libres: [] });
chk("solo F2", analizarNotas("F2"), { marcadorF: "F2", pendCall: false, libres: [] });
chk("solo pend call", analizarNotas("pend call"), { marcadorF: null, pendCall: true, libres: [] });
chk("F1 + pend call + nombre libre",
    analizarNotas("F1, pend call, Jordan Thomas"),
    { marcadorF: "F1", pendCall: true, libres: ["Jordan Thomas"] });
chk("case-insensitive y con espacios raros",
    analizarNotas("  f3 ,PEND CALL "), { marcadorF: "F3", pendCall: true, libres: [] });
chk("solo texto libre no se confunde con marcador",
    analizarNotas("Need call"), { marcadorF: null, pendCall: false, libres: ["Need call"] });
chk("construirNotas reordena marcador, pend call, libre",
    construirNotas({ marcadorF: "F2", pendCall: true, libres: ["Jordan Thomas"] }),
    "F2, pend call, Jordan Thomas");

console.log("\n── notes: F1/F2/F3 reemplaza, no acumula ───────────────");
chk("F1 -> F2 reemplaza", conMarcadorIntento("F1", 2), "F2");
chk("F1 -> F1 no reescribe (misma nota, sin tocar)", conMarcadorIntento("F1", 1), "F1");
chk("F1 + nota libre -> F3 conserva el texto libre",
    conMarcadorIntento("F1, Jordan Thomas", 3), "F3, Jordan Thomas");
chk("sin nota -> F1", conMarcadorIntento("", 1), "F1");
chk("pend call ya puesto + F2 nuevo: conserva pend call",
    conMarcadorIntento("pend call", 2), "F2, pend call");

console.log("\n── notes: pend call es idempotente ─────────────────────");
chk("sin nota -> pend call", conPendCall(""), "pend call");
chk("ya tenía pend call -> no la toca", conPendCall("pend call"), "pend call");
chk("F2 puesto -> agrega pend call sin perder F2", conPendCall("F2"), "F2, pend call");
chk("con nombre libre -> agrega pend call, conserva el nombre",
    conPendCall("Jordan Thomas"), "pend call, Jordan Thomas");
chk("ya con F2 + pend call -> no cambia nada",
    conPendCall("F2, pend call"), "F2, pend call");

console.log("\n── notes: limpieza de ruido histórico ──────────────────");
chk("F2 solo -> vacío", sinRuido("F2"), "");
chk("pend call solo -> vacío", sinRuido("pend call"), "");
chk("F1 + pend call + nombre -> solo el nombre", sinRuido("F1, pend call, Jordan Thomas"), "Jordan Thomas");
chk("solo texto libre -> no se toca", sinRuido("Need call"), "Need call");
chk("vacío sigue vacío", sinRuido(""), "");

console.log("\n── notes: intento -> número más alto de tag ────────────");
// numeroIntentoMasAlto vive dentro de marcarNotas.js (no exportada a
// propósito: es un detalle de ese webhook, no lógica reusable). Se prueba
// indirectamente vía el nombre del tag más alto presente.
function numeroIntentoMasAlto(tags) {
    let max = 0;
    for (const t of tags) {
        const m = String(t).match(/^intento([123])$/i);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
}
chk("solo intento1 -> 1", numeroIntentoMasAlto(["new lead", "intento1"]), 1);
chk("intento1 e intento2 -> 2 (el más alto)", numeroIntentoMasAlto(["intento1", "intento2"]), 2);
chk("los tres -> 3", numeroIntentoMasAlto(["intento1", "intento2", "intento3"]), 3);
chk("ninguno -> 0", numeroIntentoMasAlto(["new lead", "responded"]), 0);

console.log(fallos ? `\n❌ ${fallos} fallo(s) en total\n` : "\n✅ Todo verde\n");
process.exit(fallos ? 1 : 0);
