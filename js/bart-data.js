/*
 * bart-data.js — baked, real BART network data.
 *
 * Station coordinates (real lat/lon) and the six color-line station orders are
 * hard-coded so the map renders instantly and works offline. At runtime the
 * app refreshes coordinates/route configs from the live BART API (via the
 * /api/bart proxy) when available, and ALWAYS uses the live API for real-time
 * departures. This baked copy is the source of truth for the map shape and the
 * fallback when the API can't be reached.
 *
 * Abbreviations are BART's official 4-letter station codes (used by the API).
 */
window.VMAP_BART = {
  // tuned for legibility on a dark background; close to BART's official palette
  colors: {
    yellow: "#ffd23f",
    orange: "#f0922f",
    green:  "#4cb749",
    red:    "#e8202a",
    blue:   "#1aa3dd",
    beige:  "#cbb994"
  },

  // ABBR: [ Display name, latitude, longitude ]
  stations: {
    "12TH": ["12th St / Oakland City Center", 37.803664, -122.271604],
    "16TH": ["16th St / Mission", 37.765062, -122.419694],
    "19TH": ["19th St / Oakland", 37.808350, -122.268602],
    "24TH": ["24th St / Mission", 37.752254, -122.418466],
    "ASHB": ["Ashby", 37.853100, -122.270000],
    "ANTC": ["Antioch", 37.995388, -121.780420],
    "BALB": ["Balboa Park", 37.721667, -122.447500],
    "BAYF": ["Bay Fair", 37.696924, -122.126514],
    "BERY": ["Berryessa / North San Jose", 37.368473, -121.874681],
    "CAST": ["Castro Valley", 37.690746, -122.075602],
    "CIVC": ["Civic Center / UN Plaza", 37.779732, -122.414123],
    "COLS": ["Coliseum", 37.753661, -122.197273],
    "COLM": ["Colma", 37.684638, -122.466306],
    "CONC": ["Concord", 37.973737, -122.029095],
    "DALY": ["Daly City", 37.706121, -122.469081],
    "DBRK": ["Downtown Berkeley", 37.870104, -122.268133],
    "DUBL": ["Dublin / Pleasanton", 37.701695, -121.899179],
    "DELN": ["El Cerrito del Norte", 37.925651, -122.317227],
    "PLZA": ["El Cerrito Plaza", 37.903059, -122.299271],
    "EMBR": ["Embarcadero", 37.792874, -122.397020],
    "FRMT": ["Fremont", 37.557355, -121.976608],
    "FTVL": ["Fruitvale", 37.774963, -122.224274],
    "GLEN": ["Glen Park", 37.733064, -122.433817],
    "HAYW": ["Hayward", 37.670399, -122.087967],
    "LAFY": ["Lafayette", 37.893394, -122.123801],
    "LAKE": ["Lake Merritt", 37.797484, -122.265609],
    "MCAR": ["MacArthur", 37.828415, -122.267227],
    "MLBR": ["Millbrae", 37.599787, -122.386702],
    "MONT": ["Montgomery St", 37.789405, -122.401066],
    "NBRK": ["North Berkeley", 37.873967, -122.283440],
    "NCON": ["North Concord / Martinez", 37.999561, -122.024918],
    "OAKL": ["Oakland Int'l Airport (OAK)", 37.713238, -122.212191],
    "ORIN": ["Orinda", 37.878361, -122.183791],
    "PITT": ["Pittsburg / Bay Point", 38.018914, -121.945154],
    "PCTR": ["Pittsburg Center", 38.016941, -121.889457],
    "PHIL": ["Pleasant Hill / Contra Costa Centre", 37.928403, -122.056013],
    "POWL": ["Powell St", 37.784991, -122.406857],
    "RICH": ["Richmond", 37.936887, -122.353165],
    "ROCK": ["Rockridge", 37.844601, -122.251793],
    "SBRN": ["San Bruno", 37.637761, -122.416287],
    "SANL": ["San Leandro", 37.722619, -122.161311],
    "SFIA": ["San Francisco Int'l Airport (SFO)", 37.616035, -122.392612],
    "SHAY": ["South Hayward", 37.634483, -122.057360],
    "SSAN": ["South San Francisco", 37.664174, -122.444116],
    "UCTY": ["Union City", 37.591208, -122.017395],
    "WCRK": ["Walnut Creek", 37.905628, -122.067423],
    "WARM": ["Warm Springs / South Fremont", 37.502171, -121.939313],
    "WDUB": ["West Dublin / Pleasanton", 37.699759, -121.928240],
    "WOAK": ["West Oakland", 37.804872, -122.295140],
    "MLPT": ["Milpitas", 37.410277, -121.891081]
  },

  // Each line in operating order. Real BART color lines (2024 service plan).
  lines: [
    {
      id: "yellow", name: "Antioch – SFO / Millbrae", colorKey: "yellow",
      stations: ["ANTC","PCTR","PITT","NCON","CONC","PHIL","WCRK","LAFY","ORIN","ROCK",
                 "MCAR","19TH","12TH","WOAK","EMBR","MONT","POWL","CIVC","16TH","24TH",
                 "GLEN","BALB","DALY","COLM","SSAN","SBRN","SFIA","MLBR"]
    },
    {
      id: "red", name: "Richmond – Millbrae / Daly City", colorKey: "red",
      stations: ["RICH","DELN","PLZA","NBRK","DBRK","ASHB","MCAR","19TH","12TH","WOAK",
                 "EMBR","MONT","POWL","CIVC","16TH","24TH","GLEN","BALB","DALY","COLM",
                 "SSAN","SBRN","MLBR"]
    },
    {
      id: "orange", name: "Richmond – Berryessa", colorKey: "orange",
      stations: ["RICH","DELN","PLZA","NBRK","DBRK","ASHB","MCAR","19TH","12TH","LAKE",
                 "FTVL","COLS","SANL","BAYF","HAYW","SHAY","UCTY","FRMT","WARM","MLPT","BERY"]
    },
    {
      id: "green", name: "Berryessa – Daly City", colorKey: "green",
      stations: ["BERY","MLPT","WARM","FRMT","UCTY","SHAY","HAYW","BAYF","SANL","COLS",
                 "FTVL","LAKE","WOAK","EMBR","MONT","POWL","CIVC","16TH","24TH","GLEN",
                 "BALB","DALY"]
    },
    {
      id: "blue", name: "Dublin / Pleasanton – Daly City", colorKey: "blue",
      stations: ["DUBL","WDUB","CAST","BAYF","SANL","COLS","FTVL","LAKE","WOAK","EMBR",
                 "MONT","POWL","CIVC","16TH","24TH","GLEN","BALB","DALY"]
    },
    {
      id: "beige", name: "Coliseum – OAK Airport", colorKey: "beige",
      stations: ["COLS","OAKL"]
    }
  ]
};
