# Meteora LP Scanner v3

Userscript Tampermonkey qui affiche les pools Meteora DLMM directement sur GMGN.ai, trié par TVL puis volume.

## Fonctionnalités

- **Pools DLMM** depuis l'API publique Meteora
- **Stats globales** : TVL total, Volume 24h, ratio Vol/TVL, Fees 24h
- **Avertissements** :
  - Rouge : aucun LP trouvé (probable rug)
  - Jaune : TVL total < 10k$ (risque élevé)
  - Orange : volume 24h > 50× TVL (wash trading probable)
- **Colonne Pool Type** : affiche `binStep / fee%` (ex: `100 / 2%`)
- **Liens par pool** : Edge Meteora, LPAgent
- **Liens par token** : GMGN, Deepnets, Bubblemaps
- **Toggle MLP** fixe en bas à droite — panel ouvert uniquement sur les pages token
- **Draggable** : le panel se déplace
- **SPA-aware** : ferme le panel automatiquement quand on quitte une page token

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/)
2. Sur Brave : activer **Autoriser les scripts utilisateur** dans les paramètres de l'extension
3. Créer un nouveau script et coller le contenu de `meteora-liquidity-helper.user.js`
4. Sauvegarder — le script s'active sur `gmgn.ai/*`

## API utilisée

- `https://pool-discovery-api.datapi.meteora.ag/pools` — top 1000 pools DLMM par volume, filtrés côté client par token

## Structure du panel

| Pool Type | TVL | Vol 24h | Fees 24h | Links |
|-----------|-----|---------|----------|-------|
| 100 / 2% | $1.2M | $450K | $9K | Meteora · LPAgent |
