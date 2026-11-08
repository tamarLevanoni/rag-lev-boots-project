import "dotenv/config";
import sequelize from "../config/database";
import { loadAllData } from "../services/ragService";

async function main() {
  await sequelize.authenticate();
  await loadAllData();
  console.log("Data processed and saved. Run npm run ingest:embed next.");
}

main()
  .catch(error => { console.error("Ingestion failed:", error); process.exitCode = 1; })
  .finally(async () => { await sequelize.close(); });
