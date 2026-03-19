# Meteora Liquidity Helper v2

Userscript Tampermonkey qui affiche les pools Meteora (DLMM & DAMM v2) directement sur GMGN.ai et trade.padre.gg, trié par TVL puis volume.

## Fonctionnalités

- **Pools DLMM & DAMM v2** depuis l'API publique Meteora
- **Selector de période** : 24h, 6h, 1h, 5min (N/A si non dispo)
- **Tri** : TVL desc → Volume desc
- **Avertissements** :
  - Rouge : aucun LP trouvé (probable rug)
  - Jaune : TVL total < 10k$ (risque élevé)
  - Orange : volume 24h > 50× TVL (wash trading probable)
- **Draggable** : le panel se déplace
- **SPA-aware** : MutationObserver + patch pushState pour GMGN/Padre

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/)
2. Créer un nouveau script et coller le contenu de `meteora-liquidity-helper.user.js`
3. Sauvegarder — le script s'active sur `gmgn.ai/*` et `trade.padre.gg/*`

## API utilisée

- `https://dlmm-api.meteora.ag/pair/all` — liste tous les pools DLMM
- Fallback RPC `getProgramAccounts` sur le programme DAMM v2 si aucun pool DLMM trouvé

## Structure du panel

| Type | TVL | Vol [période] | Fee/Step | Active Bin | Pool |
|------|-----|---------------|----------|------------|------|
| DLMM | $1.2M | $450K | 0.3% | ID 8472 | abc…xyz |
