# Secteur Analyzer (version qui marche)

## 1) Installer

```bash
cd /mnt/data
npm install
```

## 2) Lancer

```bash
npm start
```

Ouvre ensuite : http://localhost:3000

## 3) Notes

- Le backend sert aussi à éviter CORS (MeilleursAgents / L'Internaute) et à faire le **screenshot** MeilleursAgents.
- La partie INSEE « évolution de la population » nécessite un token INSEE si tu veux une vraie API (sinon on met juste un lien).

### Variable d'env (optionnel)

Crée un fichier `.env` (non versionné) si tu veux :

- `INSEE_BEARER_TOKEN=...`

