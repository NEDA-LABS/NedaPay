import React, { useState, useEffect, useCallback } from 'react';
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { ethers } from 'ethers';
import { stablecoins } from '../data/stablecoins';
import { SUPPORTED_CHAINS } from '@/offramp/offrampHooks/constants';

// Define type for supported chain IDs
type ChainId = 8453 | 42161 | 137 | 42220 | 56;
import { X, AlertCircle, Wallet, Loader2 } from 'lucide-react';

interface StablecoinBalances {
  [token: string]: number;
}

interface ExchangeRates {
  [currency: string]: number;
}


interface StablecoinBalanceTrackerProps {
  isOpen: boolean;
  onClose: () => void;
}

const StablecoinBalanceTracker = ({ isOpen, onClose }: StablecoinBalanceTrackerProps) => {
  const { user, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const [balances, setBalances] = useState<StablecoinBalances>({});
  const [exchangeRates, setExchangeRates] = useState<ExchangeRates>({});
  const [selectedCurrency, setSelectedCurrency] = useState('USD');
  const [loading, setLoading] = useState(false);
  const [swapModalOpen, setSwapModalOpen] = useState(false);
  const [selectedToken, setSelectedToken] = useState('');
  const [totalBalance, setTotalBalance] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [providers, setProviders] = useState<{ [chainId: number]: ethers.providers.Provider }>({});

  // Get wallet address - prioritize embedded wallet, fallback to connected wallet
  const getWalletAddress = useCallback(() => {
    if (user?.wallet?.address) {
      return user.wallet.address;
    }
    
    // Fallback to any connected wallet
    const connectedWallet = wallets?.find(w => w.address);
    return connectedWallet?.address || null;
  }, [user, wallets]);

  const address = getWalletAddress();

  // Available currencies for conversion
  const currencies = [
    { code: 'USD', symbol: '$', name: 'US Dollar' },
    { code: 'EUR', symbol: '€', name: 'Euro' },
    { code: 'GBP', symbol: '£', name: 'British Pound' },
    { code: 'TZS', symbol: 'TSh', name: 'Tanzania Shilling' },
    { code: 'NGN', symbol: '₦', name: 'Nigerian Naira' },
    { code: 'ZAR', symbol: 'R', name: 'South African Rand' },
    { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah' },
    { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
    { code: 'BRL', symbol: 'R$', name: 'Brazilian Real' },
    { code: 'TRY', symbol: '₺', name: 'Turkish Lira' },
    { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar' },
    { code: 'MXN', symbol: '$', name: 'Mexican Peso' }
  ];

  // Initialize providers for supported chains
  const initializeProviders = useCallback(async () => {
    const newProviders: { [chainId: number]: ethers.providers.Provider } = {};
    const errorList: string[] = [];

    try {
      // Try to get embedded wallet provider first
      let web3Provider = null;
      
      if (authenticated && address && wallets) {
        const embeddedWallet = wallets.find(wallet => 
          wallet.walletClientType === 'privy' && wallet.address === address
        );
        
        if (embeddedWallet) {
          try {
            const privyEthereumProvider = await embeddedWallet.getEthereumProvider();
            if (privyEthereumProvider) {
              web3Provider = new ethers.providers.Web3Provider(privyEthereumProvider);
            }
          } catch (error) {
            console.log('Failed to get Privy provider, falling back to external wallet');
          }
        }
      }

      // Fallback to external wallet if embedded wallet not available
      if (!web3Provider && typeof window !== 'undefined' && window.ethereum) {
        try {
          web3Provider = new ethers.providers.Web3Provider(window.ethereum);
          
          // Request account access if needed
          const accounts = await web3Provider.listAccounts();
          if (accounts.length === 0) {
            await (window.ethereum as any).request({ method: 'eth_requestAccounts' });
          }
        } catch (error) {
          errorList.push('Failed to connect to external wallet');
        }
      }

      // Get unique chain IDs from stablecoins data
      const uniqueChainIds = [...new Set(stablecoins.flatMap(coin => coin.chainIds))];

      // Create providers for each chain used by stablecoins
      for (const chainId of uniqueChainIds) {
        try {
          let provider;
          
          // Find chain configuration from SUPPORTED_CHAINS
          const chainConfig = SUPPORTED_CHAINS.find(chain => chain.id === chainId);
          
          if (web3Provider && chainConfig) {
            // Try to switch to the specific chain first
            try {
              await web3Provider.send('wallet_switchEthereumChain', [
                { chainId: `0x${chainId.toString(16)}` }
              ]);
              provider = web3Provider;
            } catch (switchError) {
              // If switching fails, use RPC endpoint
              provider = new ethers.providers.JsonRpcProvider(chainConfig.rpcUrl);
            }
          } else if (chainConfig) {
            // Use RPC endpoint as fallback
            provider = new ethers.providers.JsonRpcProvider(chainConfig.rpcUrl);
          } else {
            // Fallback RPC URLs for common chains if not in SUPPORTED_CHAINS
            const fallbackRpcs: { [key: number]: string } = {
              1: 'https://ethereum.publicnode.com',
              8453: 'https://mainnet.base.org',
              42161: 'https://arb1.arbitrum.io/rpc',
              137: 'https://polygon-rpc.com',
              42220: 'https://forno.celo.org',
              56: 'https://bsc-dataseed.binance.org'
            };
            
            if (fallbackRpcs[chainId]) {
              provider = new ethers.providers.JsonRpcProvider(fallbackRpcs[chainId]);
            } else {
              errorList.push(`No RPC configuration found for chain ${chainId}`);
              continue;
            }
          }

          // Test the provider
          await provider.getBlockNumber();
          newProviders[chainId] = provider;
          console.log(`Successfully initialized provider for chain ${chainId}`);
          
        } catch (error) {
          console.error(`Failed to initialize provider for chain ${chainId}:`, error);
          errorList.push(`Failed to connect to chain ${chainId}`);
        }
      }

      setProviders(newProviders);
      setErrors(errorList);
      
    } catch (error) {
      console.error('Error initializing providers:', error);
      setErrors(['Failed to initialize blockchain connections']);
    }
  }, [authenticated, address, wallets]);

  // Fetch exchange rates from a free API
  const fetchExchangeRates = async () => {
    try {
      const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      const data = await response.json();

      const filteredRates: ExchangeRates = {};
      currencies.forEach(currency => {
        if (data.rates[currency.code]) {
          filteredRates[currency.code] = data.rates[currency.code];
        }
      });

      filteredRates['USD'] = 1;
      setExchangeRates(filteredRates);
    } catch (error) {
      console.error('Failed to fetch exchange rates:', error);
      setExchangeRates({ USD: 1 });
    }
  };

  // Fetch balance for a specific token on a specific chain
  const fetchTokenBalance = async (
    tokenAddress: string, 
    decimals: number = 18, 
    provider: ethers.providers.Provider,
    walletAddress: string
  ): Promise<string> => {
    try {
      if (tokenAddress === ethers.constants.AddressZero) {
        // Native token (ETH, MATIC, etc.)
        const balance = await provider.getBalance(walletAddress);
        return ethers.utils.formatUnits(balance, decimals);
      } else {
        // ERC-20 token
        const contract = new ethers.Contract(
          tokenAddress,
          [
            "function balanceOf(address owner) view returns (uint256)",
            "function decimals() view returns (uint8)"
          ],
          provider
        );

        const balance = await contract.balanceOf(walletAddress);
        
        // Use contract decimals if not provided
        let tokenDecimals = decimals;
        if (decimals === 18) {
          try {
            tokenDecimals = await contract.decimals();
          } catch (error) {
            // Fallback to provided decimals if contract call fails
            tokenDecimals = decimals;
          }
        }
        
        return ethers.utils.formatUnits(balance, tokenDecimals);
      }
    } catch (error) {
      console.error(`Error fetching balance for ${tokenAddress}:`, error);
      return '0';
    }
  };

  // Fetch all stablecoin balances across multiple chains
  const fetchAllBalances = useCallback(async () => {
    if (!address || !authenticated) {
      console.log('No address or not authenticated');
      return;
    }

    setLoading(true);
    setErrors([]);

    // Initialize providers if not already done
    if (Object.keys(providers).length === 0) {
      await initializeProviders();
      return; // This will trigger a re-run after providers are set
    }

    const newBalances: StablecoinBalances = {};
    const errorList: string[] = [];

    // Create promises for all balance fetches across all chains
    const balancePromises: Promise<{ token: string; chainId: number; balance: number }>[] = [];

    stablecoins.forEach((coin) => {
      // For each coin, fetch balances on all supported chains
      coin.chainIds.forEach((chainId) => {
        const tokenAddress = (coin.addresses as Record<string, string | undefined>)[chainId.toString()];
        if (!tokenAddress) return;

        const promise = (async () => {
          try {
            const provider = providers[chainId];
            
            if (!provider) {
              errorList.push(`No provider available for ${coin.baseToken} on chain ${chainId}`);
              return { token: coin.baseToken, chainId, balance: 0 };
            }

            // Get decimals for this specific chain
            let decimals = 18; // default
            if (typeof coin.decimals === 'number') {
              decimals = coin.decimals;
            } else if (typeof coin.decimals === 'object' && (chainId as ChainId) in coin.decimals) {
              decimals = coin.decimals[chainId as ChainId];
            }

            const balance = await fetchTokenBalance(
              tokenAddress,
              decimals,
              provider,
              address
            );
            
            return { token: coin.baseToken, chainId, balance: parseFloat(balance) };
          } catch (error) {
            console.error(`Failed to fetch ${coin.baseToken} balance on chain ${chainId}:`, error);
            errorList.push(`Failed to fetch ${coin.baseToken} balance on chain ${chainId}`);
            return { token: coin.baseToken, chainId, balance: 0 };
          }
        })();

        balancePromises.push(promise);
      });
    });

    try {
      // Execute all balance fetches in parallel
      const results = await Promise.allSettled(balancePromises);
      
      // Aggregate balances by token (sum across all chains)
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          const { token, balance } = result.value;
          newBalances[token] = (newBalances[token] || 0) + balance;
        } else {
          console.error('Balance fetch failed:', result.reason);
        }
      });

      setBalances(newBalances);
      setErrors(errorList);
      
    } catch (error) {
      console.error('Error fetching balances:', error);
      setErrors(['Failed to fetch token balances']);
    } finally {
      setLoading(false);
    }
  }, [address, authenticated, providers, initializeProviders]);

  // Calculate total balance in selected currency
  const calculateTotalBalance = useCallback(() => {
    let total = 0;

    stablecoins.forEach(coin => {
      const balance = balances[coin.baseToken] || 0;
      if (balance > 0) {
        const fromRate = exchangeRates[coin.currency] || 1;
        const toRate = exchangeRates[selectedCurrency] || 1;

        const usdAmount = balance / fromRate;
        const convertedBalance = usdAmount * toRate;
        total += convertedBalance;
      }
    });

    setTotalBalance(total);
  }, [balances, exchangeRates, selectedCurrency]);

  // Convert amount from one currency to another
  const convertCurrency = useCallback((amount: number, fromCurrency: string, toCurrency: string) => {
    if (!exchangeRates[fromCurrency] || !exchangeRates[toCurrency]) return amount;

    const usdAmount = amount / exchangeRates[fromCurrency];
    return usdAmount * exchangeRates[toCurrency];
  }, [exchangeRates]);

  // Get currency symbol
  const getCurrencySymbol = (currencyCode: string) => {
    const currency = currencies.find(c => c.code === currencyCode);
    return currency ? currency.symbol : currencyCode;
  };

  // Handle swap button click
  const handleSwap = (tokenSymbol: string) => {
    setSelectedToken(tokenSymbol);
    setSwapModalOpen(true);
  };

  // Initialize data
  useEffect(() => {
    fetchExchangeRates();
  }, []);

  // Initialize providers when authentication changes
  useEffect(() => {
    if (authenticated && address) {
      initializeProviders();
    }
  }, [authenticated, address, initializeProviders]);

  // Fetch balances when providers are ready
  useEffect(() => {
    if (authenticated && address && Object.keys(providers).length > 0) {
      fetchAllBalances();
    }
  }, [authenticated, address, providers, fetchAllBalances]);

  // Recalculate total when balances or rates change  
  useEffect(() => {
    calculateTotalBalance();
  }, [calculateTotalBalance]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (authenticated && address && Object.keys(providers).length > 0) {
        fetchAllBalances();
        fetchExchangeRates();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [authenticated, address, providers, fetchAllBalances]);

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-2xl shadow-xl p-8 relative">
            <button 
              onClick={onClose}
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
              aria-label="Close"
            >
              <X className="w-6 h-6" />
            </button>
            <div className="text-center">
              <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Wallet className="w-8 h-8 text-blue-600" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Connect Your Wallet</h2>
              <p className="text-gray-600">Please connect your wallet to view your stablecoin balances</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="h-[calc(100vh-4rem)] overflow-auto">
          {/* Header */}
          <div className="bg-white rounded-2xl shadow-xl mb-6 p-6">
            <div className="flex flex-col md:flex-row md:justify-between">
              <div className='flex justify-between w-full'>
                <div>
                  <h1 className="text-lg font-bold text-gray-900 mb-2">Stablecoin Portfolio</h1>
                  <p className="text-gray-600">Track your stablecoin balances across different currencies</p>
                </div>
                <button onClick={onClose} className='ml-auto'>
                  <X className='hover:text-red-500'/>
                </button>
              </div>
              
              <div className="mt-4 md:mt-0 flex space-x-2">
                <select
                  value={selectedCurrency}
                  onChange={(e) => setSelectedCurrency(e.target.value)}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {currencies.map(currency => (
                    <option key={currency.code} value={currency.code}>
                      {currency.symbol} {currency.code} - {currency.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    fetchAllBalances();
                    fetchExchangeRates();
                  }}
                  disabled={loading}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
                >
                  <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Refresh</span>
                </button>
              </div>
            </div>
          </div>

          {/* Error Messages */}
          {/* {errors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
              <div className="flex items-start">
                <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 mr-3 flex-shrink-0" />
                <div>
                  <h3 className="text-red-800 font-medium mb-2">Issues Detected:</h3>
                  <ul className="text-red-700 space-y-1">
                    {errors.map((error, index) => (
                      <li key={index} className="text-sm">• {error}</li>
                    ))}
                  </ul>
                  <div className="mt-3 text-sm text-red-600">
                    <p><strong>Troubleshooting steps:</strong></p>
                    <ol className="list-decimal list-inside mt-1 space-y-1">
                      <li>Ensure you are logged in with Privy or have a Web3 wallet installed</li>
                      <li>Connect your wallet to this website</li>
                      <li>Check that you're on the correct network</li>
                      <li>Try refreshing the page</li>
                    </ol>
                  </div>
                </div>
              </div>
            </div>
          )} */}

          {/* Debug Info */}
          {/* <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6">
            <h3 className="font-medium text-gray-800 mb-2">Debug Information:</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-600">Browser:</span>
                <span className="ml-2 font-mono">{typeof window !== 'undefined' ? 'Available' : 'Not Available'}</span>
              </div>
              <div>
                <span className="text-gray-600">Web3 Provider:</span>
                <span className="ml-2 font-mono">{walletProvider ? 'Available' : 'Not Available'}</span>
              </div>
              <div>
                <span className="text-gray-600">Wallet Address:</span>
                <span className="ml-2 font-mono">{address || 'Not Connected'}</span>
              </div>
              <div>
                <span className="text-gray-600">Authenticated:</span>
                <span className="ml-2 font-mono">{authenticated ? 'Yes' : 'No'}</span>
              </div>
            </div>
          </div> */}

          {/* Total Balance Card */}
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl shadow-xl mb-6 p-6 text-white">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium opacity-90 mb-1">Total Portfolio Value</h2>
                {loading ? (
                  <div className="flex items-center justify-center text-lg font-bold">
                    <Loader2 className="animate-spin h-8 w-8 mr-2" />
                    Loading...
                  </div>
                ) : (
                  <div>
                    <div className="text-lg font-bold">
                      {getCurrencySymbol(selectedCurrency)}{totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}
                    </div>
                    <p className="text-sm opacity-75 mt-1">
                      Across {Object.values(balances).filter(b => b > 0).length} stablecoins
                    </p>
                  </div>
                )}
              </div>
              <div className="w-16 h-16 bg-white bg-opacity-20 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                </svg>
              </div>
            </div>
          </div>

          {/* Stablecoin Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {stablecoins.map((coin) => {
              const balance = balances[coin.baseToken] || 0;
              const convertedBalance = convertCurrency(balance, coin.currency, selectedCurrency);
              const hasBalance = balance > 0;

              return (
                <div
                  key={coin.baseToken}
                  className={`bg-white rounded-xl shadow-lg border-2 transition-all duration-200 ${
                    hasBalance 
                      ? 'border-green-200 shadow-green-100' 
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="p-6">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center space-x-3">
                        <div className="text-2xl">{coin.flag}</div>
                        <div>
                          <h3 className="font-bold text-gray-900">{coin.baseToken}</h3>
                          <p className="text-sm text-gray-500">{coin.name}</p>
                        </div>
                      </div>
                      <div className={`px-2 py-1 rounded-full text-xs font-medium ${
                        hasBalance 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {coin.currency}
                      </div>
                    </div>

                    {/* Balance */}
                    <div className="mb-4">
                      <div className="text-2xl font-bold text-gray-900 mb-1">
                        {loading ? (
                          <div className="animate-pulse bg-gray-200 h-8 w-24 rounded"></div>
                        ) : (
                          <>
                            {balance.toLocaleString(undefined, { 
                              minimumFractionDigits: 2, 
                              maximumFractionDigits: 6 
                            })} {coin.baseToken}
                          </>
                        )}
                      </div>
                      <div className="text-sm text-gray-600">
                        ≈ {getCurrencySymbol(selectedCurrency)}{convertedBalance.toLocaleString(undefined, { 
                          minimumFractionDigits: 2, 
                          maximumFractionDigits: 8 
                        })}
                      </div>
                    </div>

                    {/* Token Info */}
                    <div className="space-y-2 mb-4">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Issuer:</span>
                        <span className="font-medium">{coin.issuer}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Pegged to:</span>
                        <span className="font-medium">{coin.currency}</span>
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex space-x-2">
                      <button
                        onClick={() => handleSwap(coin.baseToken)}
                        disabled={!hasBalance}
                        className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
                          hasBalance
                            ? 'bg-blue-600 text-white hover:bg-blue-700'
                            : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        <div className="flex items-center justify-center space-x-1">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                          </svg>
                          <span>Swap</span>
                        </div>
                      </button>
                      <a
                        href={coin.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 py-2 px-4 bg-gray-100 text-gray-700 rounded-lg font-medium hover:bg-gray-200 transition-colors"
                      >
                        <div className="flex items-center justify-center space-x-1">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                          <span>Info</span>
                        </div>
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer Stats */}
          <div className="bg-white rounded-2xl shadow-xl mt-6 p-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">
                  {stablecoins.length}
                </div>
                <div className="text-sm text-gray-600">Total Stablecoins</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">
                  {Object.values(balances).filter(b => b > 0).length}
                </div>
                <div className="text-sm text-gray-600">With Balance</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-purple-600">
                  {new Set(stablecoins.map(c => c.currency)).size}
                </div>
                <div className="text-sm text-gray-600">Currencies</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-orange-600">
                  {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'N/A'}
                </div>
                <div className="text-sm text-gray-600">Wallet Address</div>
              </div>
            </div>
          </div>

          {/* Simple Swap Modal */}
          {swapModalOpen && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-2xl max-w-md w-full p-6">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold">Swap {selectedToken}</h3>
                  <button
                    onClick={() => setSwapModalOpen(false)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <X className="w-6 h-6" />
                  </button>
                </div>
                <div className="text-center py-8">
                  <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                  </div>
                  <p className="text-gray-600 mb-4">
                    Swap functionality would integrate with your existing SwapModal component.
                  </p>
                  <button
                    onClick={() => setSwapModalOpen(false)}
                    className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StablecoinBalanceTracker;
