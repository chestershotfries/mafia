#!/usr/bin/env python
# coding: utf-8

# In[2]:


from trueskill import *
import random
import itertools
import math
import pandas as pd
import numpy as np


# In[3]:


env = TrueSkill(tau = 0.1, beta = 5.5, draw_probability=0.00)
env.make_as_global()
SHEET_ID = '1ePhXUVJu0m6mpQKK2YGx9SSrHfcuXH81GJHIv5A2TPg'


# In[4]:


SHEET_NAME = 'GameLog'
url = f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet={SHEET_NAME}'
df = pd.read_csv(url)


# In[5]:


# Tune the values for town and mafia

mafia_ghost_mu = 25.7
mafia_ghost_sigma = 0.8
mafia_ghost = env.Rating(mu=mafia_ghost_mu, sigma=mafia_ghost_sigma)
town_ghost_mu = 23.85
town_ghost_sigma = 0.8
town_ghost = env.Rating(mu=town_ghost_mu, sigma=town_ghost_sigma)


# In[6]:


class PlayerData:
    def __init__(self, csv_file_path):
        self.df_local_ratings = pd.read_csv(csv_file_path)
        self.default_mu = 25
        self.default_sigma = 25/3
        self.csv_file_path = csv_file_path

    def get_player_ratings(self, player_name):
        player_row = self.df_local_ratings.loc[self.df_local_ratings['Player'] == player_name]
        if player_row.empty:
            new_row = pd.DataFrame([[player_name, self.default_mu, self.default_sigma]], columns=['Player', 'mu', 'sigma'])
            self.df_local_ratings = pd.concat([self.df_local_ratings, new_row], ignore_index=True)
            self.df_local_ratings.to_csv(self.csv_file_path, index=False)
            return self.default_mu, self.default_sigma
        else:
            return player_row['mu'].values[0], player_row['sigma'].values[0]


# In[7]:


class PlayerLists:
    def __init__(self, game_id):
        self.game_id = game_id
        self.mafia_players = []
        self.town_players = []
        self.nz_players = []
        self.won_as_mafia_sum = 0
        self.excluded_sum = 0
    
    def player_list(self, df):
        # Loop through the dataframe to find matching GameIDs
        for index, row in df.iterrows():
            if row['GameID'] == self.game_id:
                player_name = row['Player']
                is_mafia = row['IsMafia']
                night_zero = row['NightZero']
                
                # If the player is mafia, add their name to the mafia_players list
                if is_mafia==1:
                    self.mafia_players.append(player_name)
                elif night_zero==1:
                    self.nz_players.append(player_name)
                else:
                    self.town_players.append(player_name)
                
                # If the player won as mafia, add their WonAsMafia score to the sum
                if is_mafia and row['WonAsMafia'] == 1:
                    self.won_as_mafia_sum += row['WonAsMafia']
                    
                if row['Exclude'] == 1:
                    self.excluded_sum += row['Exclude']
        
        return self.mafia_players, self.town_players, self.nz_players, self.won_as_mafia_sum, self.excluded_sum


# In[8]:


class RateGame:

    def __init__(self, game_id):
        self.game_id = game_id
    
    def rate_game(self):
        csv_file_path = 'C:/Users/Owner/Documents/MafiaRatings.csv'
        mh_file_path = 'C:/Users/Owner/Documents/MatchHistory.csv'
        
        df_rating = pd.read_csv(csv_file_path)
        df_mh = pd.read_csv(mh_file_path)
        players = PlayerLists(self.game_id)
        ratings = PlayerData(csv_file_path)
        mafia_players, town_players, nz_players, won_as_mafia_sum, excluded_sum = players.player_list(df)
        mafia_mu_geo_total = 1.0
        mafia_sigma_geo_total = 1.0
        mafia_win = (won_as_mafia_sum > 0)
        mafia_dict = {}
        town_dict = {}
        
        if excluded_sum > 0:
            return

        for i, player in enumerate(town_players):
            mu, sigma = ratings.get_player_ratings(player)
            town_dict[player] = Rating(mu, sigma)
        
        for i in range(len(town_players)):
            town_dict[f'town_ghost{i}'] = Rating(town_ghost_mu, town_ghost_sigma)

        for i, player in enumerate(mafia_players):
            mu, sigma = ratings.get_player_ratings(player)
            mafia_mu_geo_total *= mu
            mafia_sigma_geo_total *= sigma
            mafia_dict[player] = Rating(mu, sigma)

        mafia_mu_avg = math.pow(mafia_mu_geo_total, (1/len(mafia_players)))
        mafia_sigma_avg = math.pow(mafia_sigma_geo_total, (1/len(mafia_players)))
        
        df_rating = pd.read_csv(csv_file_path)

        for i in range(len(town_players)-len(mafia_dict)):
            mafia_dict[f'mafia_avg{i}'] = Rating(mafia_mu_avg, mafia_sigma_avg)

        for i in range(len(town_players)):
            mafia_dict[f'mafia_ghost{i}'] = Rating(mafia_ghost_mu, mafia_ghost_sigma)

        rating_groups = [(mafia_dict), (town_dict)]

        if mafia_win:
            rated_rating_groups = env.rate(rating_groups, ranks=[0, 1])
        else:
            rated_rating_groups = env.rate(rating_groups, ranks=[1, 0])
        
        for player in mafia_players:
            old_mu, old_sigma = rating_groups[0][player]
            new_mu, new_sigma = rated_rating_groups[0][player]
            old_rating = max(round((old_mu - old_sigma*1.5)*68),0)
            new_rating = max(round((new_mu - new_sigma*1.5)*68),0)
            if mafia_win: 
                result = 'Win'
            else:
                result = 'Loss'
            df_rating.loc[df_rating['Player'] == player, 'mu'] = new_mu
            df_rating.loc[df_rating['Player'] == player, 'sigma'] = new_sigma
            new_mh_row = {'GameID': self.game_id,
           'Player': player,
           'Alignment': 'Mafia',
           'Result': result,
           'RateChange': new_rating - old_rating,
           'old_mu': old_mu,
           'new_mu': new_mu,
           'old_sigma': old_sigma,
           'new_sigma': new_sigma,
           'old_rating': old_rating,
           'new_rating': new_rating}
            df_mh_row = pd.DataFrame([new_mh_row])
            df_mh = pd.concat([df_mh, df_mh_row], ignore_index=True)
        
        for player in town_players:
            old_mu, old_sigma = rating_groups[1][player]
            new_mu, new_sigma = rated_rating_groups[1][player]
            old_rating = max(round((old_mu - old_sigma*1.5)*68),0)
            new_rating = max(round((new_mu - new_sigma*1.5)*68),0)
            if mafia_win: 
                result = 'Loss'
            else:
                result = 'Win'
            df_rating.loc[df_rating['Player'] == player, 'mu'] = new_mu
            df_rating.loc[df_rating['Player'] == player, 'sigma'] = new_sigma
            new_mh_row = {'GameID': self.game_id,
           'Player': player,
           'Alignment': 'Town',
           'Result': result,
           'RateChange': new_rating - old_rating,
           'old_mu': old_mu,
           'new_mu': new_mu,
           'old_sigma': old_sigma,
           'new_sigma': new_sigma,
           'old_rating': old_rating,
           'new_rating': new_rating}
            df_mh_row = pd.DataFrame([new_mh_row])
            df_mh = pd.concat([df_mh, df_mh_row], ignore_index=True)
        
        for player in nz_players:
            new_mh_row = {'GameID': self.game_id,
           'Player': player,
           'Alignment': 'Town',
           'Result': 'Night Zero',
           'RateChange': 0,
           'old_mu': '',
           'new_mu': '',
           'old_sigma': '',
           'new_sigma': '',
           'old_rating': '',
           'new_rating': ''}
            df_mh_row = pd.DataFrame([new_mh_row])
            df_mh = pd.concat([df_mh, df_mh_row], ignore_index=True)
    
        df_rating.to_csv(csv_file_path, index=False)
        df_mh.to_csv(mh_file_path, index=False)


# In[9]:


for game_id in range(2,115):
    calc_rate = RateGame(game_id)
    calc_rate.rate_game()

# update mafia/town for 4/25

mafia_ghost_mu = 25.5
mafia_ghost_sigma = 0.8
mafia_ghost = env.Rating(mu=mafia_ghost_mu, sigma=mafia_ghost_sigma)
town_ghost_mu = 23.9
town_ghost_sigma = 0.8
town_ghost = env.Rating(mu=town_ghost_mu, sigma=town_ghost_sigma)    

for game_id in range(115,df["GameID"].max()+1):
    calc_rate = RateGame(game_id)
    calc_rate.rate_game()


# In[ ]:


def win_probability(team1, team2):
    delta_mu = sum(r.mu for r in team1) - sum(r.mu for r in team2)
    sum_sigma = sum(r.sigma ** 2 for r in itertools.chain(team1, team2))
    size = len(team1) + len(team2)
    denom = math.sqrt(size * (5.5 * 5.5) + sum_sigma)
    ##ts = trueskill.global_env()
    return env.cdf(delta_mu / denom)


# In[ ]:


mafia_ghost_mu = 33.0
mafia_ghost_sigma = 0.8
mafia_ghost = env.Rating(mu=mafia_ghost_mu, sigma=mafia_ghost_sigma)
town_ghost_mu = 24.0
town_ghost_sigma = 0.8
town_ghost = env.Rating(mu=town_ghost_mu, sigma=town_ghost_sigma)

t1 = [mafia_ghost]
t2 = [town_ghost]

win_probability(t1, t2)


# In[ ]:





# In[ ]:




