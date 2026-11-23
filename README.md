# Carango Web

Aplicação web do **Carango - Gestor de Veículos**.

Inclui dashboard, histórico, relatórios, lembretes, veículos/cadastros e formulários de abastecimento, despesa, serviço, receita, percurso e leitura de odômetro.

## Stack

- **Backend:** Node.js + API HTTP nativa
- **Banco:** MySQL (via `mysql2/promise`)
- **Frontend:** SPA em HTML/CSS/JS vanilla + Chart.js (vendor local)
- **Container:** Podman/Docker com `node:22-alpine`

## Requisitos

- **Node.js 22+** (para execução sem container)
- **MySQL 8+** acessível pela aplicação

## Configuração

Crie um `.env` a partir do exemplo:

```bash
cp .env.example .env
```

Variáveis de ambiente:

| Variável | Obrigatória | Descrição |
|---|---:|---|
| `MYSQL_HOST` | sim | Host do MySQL |
| `MYSQL_PORT` | sim | Porta do MySQL |
| `MYSQL_USER` | sim | Usuário do MySQL |
| `MYSQL_PASSWORD` | sim | Senha do MySQL |
| `MYSQL_DATABASE` | sim | Banco de dados |
| `PORT` | não | Porta HTTP da aplicação (padrão `3000`) |

Exemplo:

```env
MYSQL_HOST=192.168.x.x
MYSQL_PORT=3306
MYSQL_USER=carango
MYSQL_PASSWORD=***
MYSQL_DATABASE=carango
PORT=3000
```

A aplicação valida as credenciais no startup, cria o banco se o usuário tiver permissão e cria/ajusta as tabelas automaticamente.

## Executar com Docker / Podman

### Build

```bash
cd carango
docker build -t carango:14.2.1 .
# ou: podman build -t carango:14.2.1 .
```

### Docker Compose (recomendado)

```bash
cd carango
docker compose up -d --build
# ou: podman compose up -d --build
```

O `docker-compose.yml` publica `3210:3000` e carrega variáveis do `.env`. Não há serviço MySQL no compose; a aplicação aponta para um MySQL externo.

Acesse: `http://localhost:3210`

### Logs / parar

```bash
docker compose logs -f --tail=100
docker compose down
```

## Executar sem container

```bash
cd carango
npm install
npm start
# ou
node --env-file=.env server.js
```

## Conta demo

Ao iniciar com banco vazio, o seed cria automaticamente:

- **E-mail:** `demo@carango.app`
- **Senha:** `carango123`

A conta demo inclui veículos, abastecimentos, despesas, serviços, receitas, percursos e lembretes para visualização dos relatórios.

## Persistência

- Os dados de negócio e sessões ficam no MySQL.
- Como o banco é externo, faça backup pelo próprio MySQL (dump/snapshot).

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

## Importação / exportação

- **Exportar:** Configurações > Dados > Exportar CSV (abastecimentos, despesas, serviços, receitas, percursos, leituras).
- **Importar:** Configurações > Dados > Importar CSV por tipo. A importação aceita CSV com cabeçalhos PT-BR/EN e faz auto-detecção de colunas.

## Deploy em homelab / VPS

1. Configure o `.env` com o MySQL acessível pelo host/container.
2. Suba com `docker compose up -d --build`.
3. Coloque atrás de reverse proxy com HTTPS (Caddy/Nginx/Traefik).
4. Libere apenas a porta necessária no firewall/security group.

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
| `POST` | `/api/import/:kind` | Importação CSV/JSON por tipo |
| `GET/POST` | `/api/quick-token` | Obter/regenerar token de abastecimento rápido |
| `GET`  | `/api/quick/bootstrap` | Dados para quick page (token) |
| `POST` | `/api/quick/refueling` | Criar abastecimento rápido (token) |
| `GET/POST` | `/api/:resource` | Listar/criar recurso |
| `GET/PUT/DELETE` | `/api/:resource/:id` | Ler/atualizar/excluir recurso |

Recursos CRUD: `vehicles`, `fuels`, `stations`, `expense_types`, `service_types`, `income_types`, `reason_types`, `places`, `drivers`, `payment_methods`, `refuelings`, `expenses`, `services`, `incomes`, `routes`, `reminders`, `readings`.

## Teste E2E

O teste usa Chromium headless via CDP (sem dependências npm). Com o servidor rodando:

```bash
cd carango
BASE_URL=http://localhost:3210 node test/e2e.js
```

Opcional: `CHROME_BIN=/caminho/para/chrome`.
