import express from "express";
import fs from "fs";
import csv from "csv-parser";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(express.static("../frontend"));

const TECNICOS_FILE = "./tecnicos.csv";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const UA = "controle-tecnicos/1.0 (contato: suporte@delfia.tech)";

// ===== Helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeAddress(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[–—-]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function nominatim(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    await sleep(1000);
    const res2 = await fetch(url, { headers: { "User-Agent": UA } });
    return res2.json();
  }
  return res.json();
}

// ===== Geocodificação melhorada =====
async function getCoords(endereco) {
  if (!endereco) return null;
  const raw = endereco.trim();
  const withCountry = /brasil/i.test(raw) ? raw : `${raw}, Brasil`;
  const normalized = normalizeAddress(withCountry);

  // 1️⃣ Busca direta
  let url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(withCountry)}&format=json&limit=1&addressdetails=1`;
  let data = await nominatim(url);
  if (data?.length) return { lat: +data[0].lat, lon: +data[0].lon };

  // 2️⃣ Normalizada
  url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(normalized)}&format=json&limit=1&addressdetails=1`;
  data = await nominatim(url);
  if (data?.length) return { lat: +data[0].lat, lon: +data[0].lon };

  // 3️⃣ Estruturada (rua + cidade + estado)
  const cityUfMatch = normalized.match(/,\s*([^,]+?)\s*-\s*([A-Z]{2})\s*,\s*Brasil$/i);
  let city = null,
    state = null,
    street = null;
  if (cityUfMatch) {
    city = cityUfMatch[1].trim();
    state = cityUfMatch[2].trim().toUpperCase();
    street = normalized
      .replace(/,\s*Brasil$/i, "")
      .replace(/,\s*[^,]+?\s*-\s*[A-Z]{2}$/i, "")
      .trim();
  }

  if (city && state) {
    // (a) Busca estruturada
    url = `${NOMINATIM_BASE}/search?street=${encodeURIComponent(street)}&city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&country=Brasil&format=json&limit=1&addressdetails=1`;
    data = await nominatim(url);
    if (data?.length) return { lat: +data[0].lat, lon: +data[0].lon };

    // (b) Sem número
    const streetNoNumber = street.replace(/\b\d+\b/g, "").replace(/\s{2,}/g, " ").trim();
    if (streetNoNumber && streetNoNumber !== street) {
      url = `${NOMINATIM_BASE}/search?street=${encodeURIComponent(streetNoNumber)}&city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&country=Brasil&format=json&limit=1&addressdetails=1`;
      data = await nominatim(url);
      if (data?.length) return { lat: +data[0].lat, lon: +data[0].lon };
    }

    // (c) Busca dentro do bounding box da cidade
    url = `${NOMINATIM_BASE}/search?city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&country=Brasil&format=json&limit=1&polygon_geojson=0&addressdetails=0`;
    const cityData = await nominatim(url);
    if (cityData?.length && cityData[0].boundingbox) {
      const [latMin, latMax, lonMin, lonMax] = [
        parseFloat(cityData[0].boundingbox[0]),
        parseFloat(cityData[0].boundingbox[1]),
        parseFloat(cityData[0].boundingbox[2]),
        parseFloat(cityData[0].boundingbox[3]),
      ];
      const viewbox = `${lonMin},${latMax},${lonMax},${latMin}`;
      const streetQ = street || normalized;
      url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(streetQ)}&format=json&limit=1&bounded=1&viewbox=${viewbox}`;
      data = await nominatim(url);
      if (data?.length) return { lat: +data[0].lat, lon: +data[0].lon };
    }
  }

  // 4️⃣ Fallback: Photon (Pelias)
  try {
    const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(normalized)}&limit=1`;
    const photonRes = await fetch(photonUrl, { headers: { "User-Agent": UA } });
    const photon = await photonRes.json();
    if (photon?.features?.length) {
      const g = photon.features[0].geometry.coordinates;
      return { lat: +g[1], lon: +g[0] };
    }
  } catch (_) {}

  return null;
}

// ===== Distância via OSRM =====
async function getDistanciaKm(origem, destino) {
  const url = `${OSRM_URL}/${origem.lon},${origem.lat};${destino.lon},${destino.lat}?overview=false`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) return Infinity;
  return data.routes[0].distance / 1000;
}

// ===== Carregar técnicos =====
async function carregarTecnicos() {
  return new Promise((resolve, reject) => {
    const tecnicos = [];
    fs.createReadStream(TECNICOS_FILE)
      .pipe(csv({ separator: "," })) // CSV separado por vírgulas
      .on("data", (row) => tecnicos.push(row))
      .on("end", async () => {
        const out = [];
        for (const tecnico of tecnicos) {
          const endereco = tecnico["ENDEREÇO/RESIDENCIA"];
          if (!endereco) continue;
          const coords = await getCoords(endereco);
          if (coords) {
            tecnico.coords = coords;
            out.push(tecnico);
          } else {
            console.log("❌ Endereço não localizado:", endereco);
          }
        }
        resolve(out);
      })
      .on("error", reject);
  });
}

// ===== Endpoint principal =====
app.post("/calcular", async (req, res) => {
  const { endereco } = req.body;
  if (!endereco) return res.status(400).json({ erro: "Endereço não informado" });

  const destino = await getCoords(endereco);
  if (!destino) return res.status(400).json({ erro: "Endereço do atendimento inválido ou não encontrado" });

  const tecnicos = await carregarTecnicos();
  if (tecnicos.length === 0) return res.status(404).json({ erro: "Nenhum técnico disponível com endereço válido" });

  let melhor = null;

  for (const tecnico of tecnicos) {
    const km = await getDistanciaKm(tecnico.coords, destino);
    const valor = km * 2 * 1.3;
    tecnico.distancia = km.toFixed(2);
    tecnico.valor = valor.toFixed(2);

    if (!melhor || km < melhor.distancia) melhor = tecnico;
  }

  res.json({ tecnico: melhor });
});

// ===== Inicialização =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));
