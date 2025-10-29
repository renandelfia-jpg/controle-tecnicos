import express from "express";
import fs from "fs";
import csv from "csv-parser";
import fetch from "node-fetch";
import path from "path";

const app = express();
app.use(express.json());
app.use(express.static("../frontend"));

const TECNICOS_FILE = "./tecnicos.csv";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

async function getCoords(endereco) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(endereco)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "User-Agent": "controle-tecnicos-app" } });
  const data = await res.json();
  if (data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function getDistanciaKm(origem, destino) {
  const url = `${OSRM_URL}/${origem.lon},${origem.lat};${destino.lon},${destino.lat}?overview=false`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) return Infinity;
  return data.routes[0].distance / 1000;
}

async function carregarTecnicos() {
  return new Promise((resolve, reject) => {
    const tecnicos = [];
    fs.createReadStream(TECNICOS_FILE)
      .pipe(csv({ separator: "\t" }))
      .on("data", (row) => tecnicos.push(row))
      .on("end", async () => {
        for (const tecnico of tecnicos) {
          const coords = await getCoords(tecnico["ENDEREÇO/RESIDENCIA"]);
          tecnico.coords = coords;
        }
        resolve(tecnicos.filter((t) => t.coords));
      })
      .on("error", reject);
  });
}

app.post("/calcular", async (req, res) => {
  const { endereco } = req.body;
  if (!endereco) return res.status(400).json({ erro: "Endereço não informado" });

  const destino = await getCoords(endereco);
  if (!destino) return res.status(400).json({ erro: "Endereço do atendimento inválido" });

  const tecnicos = await carregarTecnicos();
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));