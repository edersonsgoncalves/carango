# Carango Web

Criação web do app **Carango - Gestor de Veículos**.

A aplicação possui os principais fluxos: dashboard, histórico, relatórios, lembretes, veículos/cadastros e formulários de abastecimento, despesa, serviço, receita, percurso e leitura de odômetro.

## Stack

- **Backend:** Node.js (módulos built-in, sem dependências npm)
- **Banco:** SQLite via `node:sqlite` (built-in do Node 22+)
- **Frontend:** SPA em HTML/CSS/JS vanilla + Chart.js (vendor local)
- **Container:** Podman/Docker com `node:22-alpine`

## Estrutura

```text
carango/
├── db.js                 # Schema SQLite, seed demo e autenticação
├── server.js             # Servidor HTTP + API REST + arquivos estáticos
├── public/
│   ├── index.html        # Shell da SPA
│   ├── styles.css        # Estilos
│   ├── app.js            # SPA (rotas, views, formulários, gráficos)
│   └── vendor/
│       └── chart.umd.js  # Chart.js
├── test/
│   └── e2e.js            # Teste E2E headless via CDP/Chromium
├── Dockerfile
└── .dockerignore
```

## Executar com Podman

### Build

```bash
cd carango
podman build -t carango-web:1.0.0 .
```

### Run (com persistência do SQLite)

```bash
mkdir -p data
podman run -d --name carango-web --replace \
  -p 3210:3000 \
  -v "$(pwd)/data:/app/data:Z" \
  localhost/carango-web:1.0.0
```

Acesse: http://localhost:3210

O banco fica em `./data/carango.db` (montado em `/app/data` no container). Para reiniciar sem perder dados, use o mesmo volume.

### Logs / parar

```bash
podman logs -f carango-web
podman stop carango-web
podman rm carango-web
```

## Executar sem container (desenvolvimento)

Requer **Node.js 22+** (por causa do `node:sqlite`).

```bash
cd carango
node server.js
# ou porta customizada
PORT=3210 node server.js
```

Variáveis de ambiente:

| Variável  | Padrão                 | Descrição                        |
|-----------|------------------------|----------------------------------|
| `PORT`    | `3000`                 | Porta HTTP                       |
| `DB_PATH` | `./data/carango.db`     | Caminho do arquivo SQLite        |

## Conta demo

Ao iniciar com banco vazio, o seed cria automaticamente:

- **E-mail:** `demo@carango.app`
- **Senha:** `carango123`

A conta demo inclui veículos, abastecimentos, despesas, serviços, receitas, percursos e lembretes para visualização dos relatórios.

## Abastecimento rápido

Para registrar combustível direto no posto, use a página mobile `quick.html`:

1. No app, vá em **Configurações > Abastecimento rápido**.
2. Copie o link com token (ou clique em **Abrir**).
3. Salve na tela inicial do celular.

O link usa token próprio (pode ser regenerado). Também dá para integrar via API:

```bash
curl -X POST "https://SEU_HOST/api/quick/refueling?token=SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"vehicle_id":1,"odometer":61200,"volume":30,"price":5.59,"full_tank":1}'
```

Campos aceitos: `vehicle_id`, `date` (YYYY-MM-DD), `odometer`, `volume`, `price`, `total`, `full_tank`, `fuel_id`, `station_id`, `notes`. Se 2 entre `volume/preço/total` forem informados, o terceiro é calculado.

> WhatsApp direto exigiria integração com Meta/Twilio; o endpoint de token acima pode ser ligado a um bot/webhook de WhatsApp/Telegram/atalhos.

## Importação / exportação

- **Exportar:** Configurações > Dados > Exportar CSV (abastecimentos, despesas, serviços, receitas, percursos, leituras).
- **Importar:** Configurações > Dados > Importar abastecimentos (CSV). Colunas reconhecidas: `data/date`, `odometro/km`, `volume/litros`, `preco`, `total`, `tanque_cheio/full_tank`, `combustivel/fuel`, `posto/station`, `observacao/notes`.

## Dados e persistência

- **Drivers:** `DB_DRIVER=sqlite` (padrão) ou `DB_DRIVER=mysql`.
- **SQLite:** arquivo em `DB_PATH` (padrão `./data/carango.db`). No container, monte `./data:/app/data`.
- **MySQL:** configure `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`. A aplicação cria o banco (se o usuário tiver permissão) e as tabelas no startup.
- Sessões de login são em memória (reinício do servidor exige novo login); dados de negócio ficam no banco.

### .env (exemplo)

```env
DB_DRIVER=mysql
MYSQL_HOST=192.168.x.x
MYSQL_PORT=3306
MYSQL_USER=carango
MYSQL_PASSWORD=***
MYSQL_DATABASE=carango
PORT=3000
```

## Deploy em homelab / VPS

### Docker Compose (recomendado)

```bash
cd carango
mkdir -p data
docker compose up -d --build
# ou: podman compose up -d --build
```

O arquivo `docker-compose.yml` publica `3210:3000` e monta `./data:/app/data`.

### Produção

- Coloque atrás de reverse proxy com HTTPS (Caddy/Nginx/Traefik).
- Faça backup periódico de `./data/carango.db`.
- Defina `PORT` e `DB_PATH` conforme ambiente.
- Para CI/CD no GitHub (etapa seguinte): build da imagem, push para registry (GHCR/Docker Hub) e deploy via SSH/Watchtower/Compose. O Dockerfile já está pronto para isso.

## API (resumo)

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/api/login` | Login (`email`, `password`) |
| `POST` | `/api/register` | Cadastro |
| `POST` | `/api/logout` | Logout |
| `GET`  | `/api/me` | Usuário autenticado |
| `GET`  | `/api/dashboard` | Resumo/KPIs (opcional `?vehicle_id=`) |
| `GET`  | `/api/last-odometer` | Último odômetro do veículo (`vehicle_id`) |
| `GET`  | `/api/history` | Histórico unificado com filtros |
| `GET`  | `/api/reports` | Dados para gráficos/relatórios |
| `GET`  | `/api/export.csv` | Exportação CSV |
| `POST` | `/api/import/refuelings` | Importação CSV/JSON de abastecimentos |
| `GET/POST` | `/api/quick-token` | Obter/regenerar token de abastecimento rápido |
| `GET`  | `/api/quick/bootstrap` | Dados para quick page (token) |
| `POST` | `/api/quick/refueling` | Criar abastecimento rápido (token) |
| `GET/POST` | `/api/:resource` | Listar/criar recurso |
| `GET/PUT/DELETE` | `/api/:resource/:id` | Ler/atualizar/excluir recurso |

Recursos CRUD: `vehicles`, `fuels`, `stations`, `expense_types`, `service_types`, `income_types`, `reason_types`, `places`, `drivers`, `payment_methods`, `refuelings`, `expenses`, `services`, `incomes`, `routes`, `reminders`, `readings`.

## Teste E2E

O teste usa Chromium headless via CDP (sem dependências npm). Com o servidor rodando em `http://localhost:3210`:

```bash
cd carango
BASE_URL=http://localhost:3210 node test/e2e.js
```

Opcional: `CHROME_BIN=/caminho/para/chrome`.
