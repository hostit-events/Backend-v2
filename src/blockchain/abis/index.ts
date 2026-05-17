/**
 * ABIs for the HostItTickets Diamond on Base Sepolia.
 *
 * Source of truth: contracts repo at hostit-events/ticket. Pasted from
 * the verified Blockscout entries for each facet. When the contracts
 * change, regenerate by either:
 *   - Pulling each facet's ABI from Blockscout's Code tab, or
 *   - Running `forge build` in the contracts repo and copying
 *     out/{Facet}.sol/{Facet}.json's `.abi` array here.
 *
 * The Diamond at DIAMOND_CONTRACT_ADDRESS forwards every selector to
 * the appropriate facet, so we expose a merged ABI that ethers can use
 * to talk to the proxy as if all methods lived on it directly.
 */

import factoryFacetAbi from './factory-facet.json';
import marketplaceFacetAbi from './marketplace-facet.json';
import checkinFacetAbi from './checkin-facet.json';
import accessControlFacetAbi from './access-control-facet.json';

export {
  factoryFacetAbi,
  marketplaceFacetAbi,
  checkinFacetAbi,
  accessControlFacetAbi,
};

/**
 * Union of every selector exposed by the Diamond. Use this when
 * instantiating an ethers Contract against DIAMOND_CONTRACT_ADDRESS.
 *
 * Note: per-ticket main-admin roles are auto-granted to the
 * createTicket caller, so the treasury wallet picks them up implicitly
 * once Circle SCP starts signing event-publish jobs (#34, #67). No
 * separate grant step is required at deploy time. AccessControl is
 * merged in so the platform admin can call grantRole(hostItTicketHash,
 * organizerSCA) when we move createTicket to organizer-signed via Gas
 * Station. OwnableFacet + DiamondLoupe ABIs can be added if/when we
 * need to call withdrawHostItBalance (platform owner) or introspect
 * facets — neither is on the immediate path.
 */
export const diamondAbi = [
  ...factoryFacetAbi,
  ...marketplaceFacetAbi,
  ...checkinFacetAbi,
  ...accessControlFacetAbi,
];
